// Flora: the real trees of the corridor, where the aerial photograph shows them.
// Streams SPEC_v2 tree tiles (tiles/t/7/tx_ty.bin: position, crown radius, height, species, tint per tree)
// and draws them in three rings around the camera:
//   near (< ~130 m): full 3D trees, bark tubes + alpha-tested leaf cards (procedural leaf/bark atlas),
//                    per-instance tint/scale, wind sway + leaf flutter, back-lit translucent leaves,
//                    crown-interior AO, dappled leaf shadows (near ring only)
//   mid  (< ~560 m): the same trees with a fifth of the leaf cards (each enlarged), trunk + main limbs
//   far  (< ~1.6 km): one camera-facing impostor quad per tree (rendered from the near model at start-up)
// Beyond that the NAIP ground photo carries the canopy. One draw call per species per ring (+1 for all
// impostors), so a leafy Palo Alto view costs ~20-30 calls.
//   Flora.init(ctx)            ctx = { renderer?, scene? } (defaults: Env.renderer / Env.scene); call once
//   Flora.update(camPos, env)  every frame (streams tiles, rebuilds rings when the camera moves)
//   Flora.group                add to the scene (init() does this when a scene is given)
//   Flora.hasData(x, z)        true when a tree tile covers (x, z): Towns should skip its own trees there (alias: covers)
//   Flora.stats                counters; Flora.setQuality('ultraplus'|'high'|'medium'|'low')
// Tree data: tiles/t2 (measured heights, extra crowns; tools/bake_trees2.py) where published, else tiles/t.
const Flora = (() => {
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const V3 = THREE.Vector3;
  // SPEC_v2 world tiling (level 7 = 800 m tiles)
  const X0 = -45056, Z0 = -49152, SIZE = 102400, L7 = 7, T7 = SIZE / 128;
  const KINDS = ['oak', 'redwood', 'eucalyptus', 'palm', 'sycamore', 'cypress', 'pine', 'street', 'fanpalm', 'shrub'];   // shrub: generated along the line
  const NK = KINDS.length;
  const Q = {   // quality tiers (instance capacities are allocated for high at init: ultraplus only reaches farther)
    ultraplus: { near: 170, mid: 700, far: 2100, load: 2400, shadows: true, nearMax: 1400, midMax: 9000, farMax: 160000 },
    high: { near: 135, mid: 560, far: 1650, load: 1900, shadows: true, nearMax: 1400, midMax: 9000, farMax: 160000 },
    medium: { near: 95, mid: 420, far: 1300, load: 1550, shadows: true, nearMax: 800, midMax: 6000, farMax: 110000 },
    low: { near: 55, mid: 300, far: 950, load: 1200, shadows: false, nearMax: 350, midMax: 3500, farMax: 70000 },
  };
  let q = Q.high, qName = 'high';
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ==========================================================================================
  // ATLAS: 2048² canvas, 4×4 regions of 512² (leaf clusters with alpha, tileable barks)
  // ==========================================================================================
  const AT = 2048, RS = 512;
  const REG = {   // region index -> painter
    oakLeaf: 0, planeLeaf: 1, streetLeaf: 2, eucLeaf: 3, redwoodSpray: 4, pineTuft: 5, cypressClump: 6, palmFrond: 7,
    fanLeaf: 8, deadFrond: 9, barkOak: 10, barkRedwood: 11, barkEuc: 12, barkPlane: 13, barkPalm: 14, barkPine: 15,
  };
  // region -> [u0, v0, du, dv] in texture space (v up: three flips canvases, so canvas row 0 = v 1)
  function regionUV(r) { const cx = r % 4, cy = Math.floor(r / 4); return [cx * 0.25, 1 - (cy + 1) * 0.25, 0.25, 0.25]; }
  const col = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  function jitterColor(c, r, amt, bright = 0) { const k = 1 + (r() - 0.5) * amt + bright; return [clamp(c[0] * k + (r() - 0.5) * 10, 0, 255), clamp(c[1] * k + (r() - 0.5) * 10, 0, 255), clamp(c[2] * k + (r() - 0.5) * 8, 0, 255)]; }

  // one leaf blade along +x (length L, width W); shapes: oval, lance, oak, palmate
  function leafPath(g, L, W, shape) {
    g.beginPath(); g.moveTo(0, 0);
    if (shape === 'lance') { g.bezierCurveTo(L * 0.25, W * 1.1, L * 0.7, W * 0.7, L, 0); g.bezierCurveTo(L * 0.72, -W * 0.25, L * 0.3, -W * 0.55, 0, 0); }
    else if (shape === 'palmate') {
      const lobes = 5; const pts = [];
      for (let i = 0; i <= lobes * 2; i++) { const a = -1.15 + 2.3 * i / (lobes * 2); const rr = (i % 2 ? 0.52 : 1.0) * L; pts.push([Math.cos(a) * rr, Math.sin(a) * rr * (W / L) * 1.6]); }
      g.moveTo(0, 0); for (const [x, y] of pts) g.lineTo(x, y); g.lineTo(0, 0);
    } else if (shape === 'oak') {   // small, oval, slightly holly-toothed
      const n = 7; g.moveTo(0, 0);
      for (let i = 1; i <= n; i++) { const u = i / n; const w = Math.sin(Math.PI * Math.min(1, u * 1.05)) * W * (i % 2 ? 1.08 : 0.92); g.lineTo(u * L, w); }
      for (let i = n; i >= 0; i--) { const u = i / n; const w = Math.sin(Math.PI * Math.min(1, u * 1.05)) * W * (i % 2 ? 1.08 : 0.92); g.lineTo(u * L, -w); }
    } else { g.bezierCurveTo(L * 0.2, W * 1.05, L * 0.75, W * 0.95, L, 0); g.bezierCurveTo(L * 0.75, -W * 0.95, L * 0.2, -W * 1.05, 0, 0); }
    g.closePath();
  }
  // normal-atlas colour for a canvas-space normal (x right, y down): stored as texture-space xyz * 0.5 + 0.5 (v up)
  const nrmCol = (nx, ny, nz) => { const l = Math.hypot(nx, ny, nz) || 1; return col((nx / l * 0.5 + 0.5) * 255, (-ny / l * 0.5 + 0.5) * 255, (nz / l * 0.5 + 0.5) * 255); };
  const FLAT_N = 'rgb(128,128,255)';
  // gN: the normal atlas (same blade: a random tilt plus a fold along the midrib); shade: darker deeper in the cluster
  function drawLeaf(g, x, y, ang, L, W, c, shape, r, gloss = 0.25, gN = null, shade = 1) {
    const under = r() < 0.12;                                                 // a few show their paler underside
    const bc = under ? [c[0] * 1.18 + 20, c[1] * 1.12 + 20, c[2] * 1.1 + 16] : c;
    const hi = jitterColor(bc, r, 0.1, gloss).map(v => v * shade), lo = jitterColor(bc, r, 0.1, -0.24).map(v => v * shade);
    g.save(); g.translate(x, y); g.rotate(ang);
    leafPath(g, L, W, shape);
    const gr = g.createLinearGradient(0, -W, 0, W);                            // the two halves either side of the midrib
    gr.addColorStop(0, col(...hi)); gr.addColorStop(0.48, col(...hi.map((v, i) => lerp(v, lo[i], 0.3)))); gr.addColorStop(0.52, col(...lo)); gr.addColorStop(1, col(...lo.map(v => v * 0.86)));
    g.fillStyle = gr; g.fill();
    if (L > 10) { g.strokeStyle = col(...jitterColor(bc, r, 0.1, 0.3).map(v => v * shade), 0.55); g.lineWidth = Math.max(0.6, W * 0.08); g.beginPath(); g.moveTo(L * 0.05, 0); g.lineTo(L * 0.9, 0); g.stroke(); }
    g.restore();
    if (gN) {
      const tx = (r() - 0.5) * 1.0, ty = (r() - 0.5) * 1.0, fold = 0.3 + r() * 0.3, ca = Math.cos(ang), sa = Math.sin(ang);
      const enc = (lx, ly) => nrmCol(lx * ca - ly * sa, lx * sa + ly * ca, 1);   // blade-local tilt -> canvas space
      gN.save(); gN.translate(x, y); gN.rotate(ang); leafPath(gN, L, W, shape);
      const gn = gN.createLinearGradient(0, -W, 0, W);
      gn.addColorStop(0, enc(tx, ty - fold)); gn.addColorStop(0.5, enc(tx, ty)); gn.addColorStop(1, enc(tx, ty + fold));
      gN.fillStyle = gn; gN.fill(); gN.restore();
    }
  }
  // a dense spray of leaves on twigs radiating from the bottom centre of the region. Nothing crosses the circle of
  // radius 0.46*S around the region centre, so cards never show a straight cut edge.
  function paintCluster(g, x0, y0, o, seed, gN) {
    const r = rng(seed); const S = RS, cx = x0 + S / 2, cy = y0 + S * 0.93, mx = x0 + S / 2, my = y0 + S / 2, R = S * 0.46;
    // a lobed outline (still inside the circle of radius R, which the octagon cards keep) and leaves thinning toward it:
    // a card seen on its own against the sky reads as a ragged spray, not a disc
    const k1 = 3 + Math.floor(r() * 3), p1 = r() * TAU, p2 = r() * TAU;
    const rim = (a) => R * (0.74 + 0.18 * Math.sin(a * k1 + p1) + 0.08 * Math.sin(a * (k1 * 2 + 1) + p2));
    const inside = (x, y, pad) => Math.hypot(x - mx, y - my) < rim(Math.atan2(y - my, x - mx)) - pad;
    // leaves are queued with a depth and drawn back to front: the ones behind are darker (the cluster shades itself)
    const queue = [];
    const leaf = (x, y, a, L, W, c, dep) => { const tx = x + Math.cos(a) * L, ty = y + Math.sin(a) * L; if (!inside(x, y, 2) || !inside(tx, ty, 2)) return; queue.push([x, y, a, L, W, c, dep]); };
    const twigs = o.twigs || 7;
    for (let t = 0; t < twigs; t++) {
      const a = -Math.PI / 2 + (t / (twigs - 1) - 0.5) * (o.spread || 2.3) + (r() - 0.5) * 0.25;
      const len = S * lerp(0.5, 0.72, r());
      const pts = []; let px = cx + (r() - 0.5) * 24, py = cy, aa = a;
      for (let i = 0; i <= 10; i++) { pts.push([px, py]); aa += (r() - 0.5) * 0.18 + (o.droop || 0) * 0.04; px += Math.cos(aa) * len / 10; py += Math.sin(aa) * len / 10; }
      g.strokeStyle = col(...o.twig); g.lineCap = 'round'; if (gN) { gN.strokeStyle = FLAT_N; gN.lineCap = 'round'; }
      for (let i = 0; i < 10; i++) { if (!inside(pts[i + 1][0], pts[i + 1][1], 6)) break; g.lineWidth = lerp(o.twigW || 5, 1, i / 10); g.beginPath(); g.moveTo(...pts[i]); g.lineTo(...pts[i + 1]); g.stroke();
        if (gN) { gN.lineWidth = g.lineWidth; gN.beginPath(); gN.moveTo(...pts[i]); gN.lineTo(...pts[i + 1]); gN.stroke(); } }
      const n = o.perTwig || 18;
      for (let k = 0; k < n; k++) {
        const u = Math.pow(r(), 0.7) * 0.95 + 0.05; const i = Math.min(9, Math.floor(u * 10)); const f = u * 10 - i;
        const x = lerp(pts[i][0], pts[i + 1][0], f), y = lerp(pts[i][1], pts[i + 1][1], f);
        const side = k % 2 ? 1 : -1; const la = aa + side * lerp(0.5, 1.2, r()) + (o.leafDroop || 0) * (r() * 0.8 + 0.4);
        leaf(x, y, la, o.leafL * lerp(0.75, 1.2, r()), o.leafW * lerp(0.8, 1.2, r()), o.palette[Math.floor(r() * o.palette.length)], 0.3 + 0.7 * r());
      }
    }
    // fill the body so the cluster reads as a foliage mass, densest in the middle, ragged toward the rim
    for (let k = 0; k < (o.fill || 60); k++) {
      const a = r() * TAU, d = Math.pow(r(), 1.15) * rim(a) * 0.96;
      leaf(mx + Math.cos(a) * d, my + Math.sin(a) * d, r() * TAU, o.leafL * lerp(0.7, 1.1, r()), o.leafW * lerp(0.8, 1.2, r()), o.palette[Math.floor(r() * o.palette.length)], r());
    }
    queue.sort((a, b) => a[6] - b[6]);
    for (const [x, y, a, L, W, c, dep] of queue) drawLeaf(g, x, y, a, L, W, c, o.shape, r, o.gloss, gN, lerp(0.58, 1.1, dep) * lerp(1.06, 0.92, (y - y0) / S));
  }
  function paintRedwood(g, x0, y0, seed) {   // fern-like flat sprays: branchlets with alternate twigs, each twig two rows of short flat needles
    const r = rng(seed); const S = RS; g.save(); g.beginPath(); g.rect(x0 + 4, y0 + 4, S - 8, S - 8); g.clip();
    const pal = [[40, 66, 36], [50, 80, 42], [34, 58, 32], [58, 88, 46]], tip = [92, 122, 60];
    // one twig from (x, y) along angle a: a thin stem with needles (~2-3 cm on a ~2 m card) alternating on both sides,
    // shortening and turning to lighter new growth toward the tip
    const twig = (x, y, a, len, c0) => {
      const dx = Math.cos(a), dy = Math.sin(a), n = Math.max(3, Math.round(len / 3.1));
      g.strokeStyle = col(70, 60, 40); g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx * len, y + dy * len); g.stroke();
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, px = x + dx * len * t, py = y + dy * len * t, nl = lerp(7.5, 3.5, t) * lerp(0.85, 1.15, r());
        g.fillStyle = col(...jitterColor([lerp(c0[0], tip[0], t * t), lerp(c0[1], tip[1], t * t), lerp(c0[2], tip[2], t * t)], r, 0.18));
        for (const sd of [-1, 1]) {
          const na = a + sd * lerp(1.1, 1.35, r());
          g.save(); g.translate(px + Math.cos(na) * nl * 0.5, py + Math.sin(na) * nl * 0.5); g.rotate(na);
          g.beginPath(); g.ellipse(0, 0, nl * 0.5, 1.3, 0, 0, TAU); g.fill(); g.restore();
        }
      }
    };
    for (let b = 0; b < 7; b++) {
      // a gently curving branchlet across the card; alternate twigs shorten toward its tip
      let px = x0 + S * 0.06 + r() * 30, py = y0 + S * (0.1 + b * 0.125) + (r() - 0.5) * 20, a = (r() - 0.5) * 0.35;
      const segs = 14, len = S * lerp(0.7, 0.88, r()), base = pal[Math.floor(r() * 4)];
      for (let i = 0; i < segs; i++) {
        const nx = px + Math.cos(a) * len / segs, ny = py + Math.sin(a) * len / segs; a += (r() - 0.45) * 0.06;
        g.strokeStyle = col(88, 66, 44); g.lineWidth = lerp(2.4, 1.2, i / segs); g.beginPath(); g.moveTo(px, py); g.lineTo(nx, ny); g.stroke();
        const u = i / segs, tl = lerp(58, 20, u) * lerp(0.8, 1.1, r());
        twig(nx, ny, a + (i % 2 ? 1 : -1) * lerp(0.75, 0.95, r()), tl, base);
        px = nx; py = ny;
      }
      twig(px, py, a, 22, base);                                            // the leader
    }
    g.restore();
  }
  function paintPine(g, x0, y0, seed) {   // tufts of long needles at twig tips
    const r = rng(seed); const S = RS; g.save(); g.beginPath(); g.rect(x0 + 4, y0 + 4, S - 8, S - 8); g.clip();
    const pal = [[44, 66, 40], [52, 76, 44], [36, 58, 36], [60, 84, 50]];
    for (let t = 0; t < 26; t++) {
      const cx = x0 + S * (0.15 + 0.7 * r()), cy = y0 + S * (0.15 + 0.7 * r());
      g.strokeStyle = col(80, 62, 46); g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy + 30); g.lineTo(cx, cy); g.stroke();
      for (let k = 0; k < 70; k++) {
        const a = -Math.PI / 2 + (r() - 0.5) * 3.4, L = lerp(45, 95, r());
        g.strokeStyle = col(...jitterColor(pal[Math.floor(r() * 4)], r, 0.3)); g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(cx + Math.cos(a) * L * 0.5, cy + Math.sin(a) * L * 0.5 - 6, cx + Math.cos(a) * L, cy + Math.sin(a) * L); g.stroke();
      }
    }
    g.restore();
  }
  function paintCypress(g, x0, y0, seed) {   // dense scale-leaf clumps: overlapping rounded knots
    const r = rng(seed); const S = RS; g.save(); g.beginPath(); g.rect(x0 + 4, y0 + 4, S - 8, S - 8); g.clip();
    const pal = [[62, 88, 52], [72, 98, 58], [54, 78, 46], [82, 108, 64]];
    for (let k = 0; k < 1100; k++) {
      const a = r() * TAU, d = Math.pow(r(), 0.6) * S * 0.44;
      const x = x0 + S / 2 + Math.cos(a) * d * 1.0, y = y0 + S * 0.5 + Math.sin(a) * d * 0.7;
      const rr = lerp(5, 13, r()) * (1 - d / (S * 0.52)); if (rr < 1.5) continue;
      const c = jitterColor(pal[Math.floor(r() * 4)], r, 0.3, (y0 + S * 0.52 - y) / S * 0.6);
      const gr = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 0.5, x, y, rr);
      gr.addColorStop(0, col(c[0] * 1.3, c[1] * 1.3, c[2] * 1.25)); gr.addColorStop(1, col(c[0] * 0.7, c[1] * 0.7, c[2] * 0.7));
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
    }
    g.restore();
  }
  function paintFrond(g, x0, y0, seed, dead) {   // pinnate palm frond along +x (the card's length axis), leaflets both sides
    const r = rng(seed); const S = RS; g.save(); g.beginPath(); g.rect(x0 + 2, y0 + 2, S - 4, S - 4); g.clip();
    const pal = dead ? [[122, 98, 66], [138, 112, 76], [104, 84, 58]] : [[84, 112, 48], [96, 124, 54], [74, 102, 44], [106, 132, 60]];
    const cy = y0 + S / 2;
    g.strokeStyle = col(...(dead ? [110, 88, 60] : [140, 138, 84])); g.lineWidth = 7; g.beginPath(); g.moveTo(x0 + 6, cy); g.lineTo(x0 + S - 10, cy); g.stroke();
    for (let i = 0; i < 64; i++) {
      const u = i / 64; const x = x0 + 16 + u * (S - 30);
      const L = S * 0.44 * Math.sin(Math.PI * Math.min(1, 0.08 + u * 0.95)) * lerp(0.85, 1.05, r());
      for (const s of [-1, 1]) {
        const a = s * lerp(0.55, 0.8, r()) + (dead ? s * 0.5 : 0);
        const c = jitterColor(pal[Math.floor(r() * pal.length)], r, 0.25);
        g.strokeStyle = col(...c); g.lineWidth = dead ? 3 : 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x, cy); g.quadraticCurveTo(x + Math.cos(a) * L * 0.6, cy + Math.sin(a) * L * 0.55 + (dead ? L * 0.25 : 0), x + Math.cos(a) * L * 0.9, cy + Math.sin(a) * L);
        g.stroke();
      }
    }
    g.restore();
  }
  function paintFan(g, x0, y0, seed) {   // fan palm leaf: pleated half disc, split tips; stalk from the bottom centre
    const r = rng(seed); const S = RS; g.save(); g.beginPath(); g.rect(x0 + 2, y0 + 2, S - 4, S - 4); g.clip();
    const cx = x0 + S / 2, cy = y0 + S * 0.78, R = S * 0.47;
    g.strokeStyle = col(120, 120, 70); g.lineWidth = 8; g.beginPath(); g.moveTo(cx, y0 + S); g.lineTo(cx, cy); g.stroke();
    const n = 46;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * (1.08 + 0.84 * i / n), a1 = Math.PI * (1.08 + 0.84 * (i + 1) / n);
      const c = jitterColor(i % 2 ? [88, 118, 56] : [72, 100, 46], r, 0.18);
      const rr = R * lerp(0.9, 1.0, r());
      g.fillStyle = col(...c); g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0) * rr * 0.72, cy + Math.sin(a0) * rr * 0.72);
      g.lineTo(cx + Math.cos((a0 + a1) / 2) * rr, cy + Math.sin((a0 + a1) / 2) * rr);   // split tip
      g.lineTo(cx + Math.cos(a1) * rr * 0.72, cy + Math.sin(a1) * rr * 0.72); g.closePath(); g.fill();
    }
    g.restore();
  }
  // ---- tileable barks (wrap every stroke in x and y)
  function wrapDraw(x0, y0, fn) { for (const dx of [-RS, 0, RS]) for (const dy of [-RS, 0, RS]) fn(dx, dy); }
  function paintBark(g, x0, y0, seed, kind) {
    const r = rng(seed); const S = RS;
    g.save(); g.beginPath(); g.rect(x0, y0, S, S); g.clip(); g.translate(x0, y0);
    const base = { barkOak: [78, 66, 55], barkRedwood: [112, 62, 42], barkEuc: [196, 184, 158], barkPlane: [172, 166, 138], barkPalm: [118, 98, 74], barkPine: [92, 78, 64] }[kind];
    g.fillStyle = col(...base); g.fillRect(0, 0, S, S);
    const wrap = (fn) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy); };
    if (kind === 'barkOak' || kind === 'barkPine' || kind === 'barkRedwood') {
      const n = kind === 'barkRedwood' ? 90 : 60;
      for (let i = 0; i < n; i++) {
        const x = r() * S, w = lerp(3, kind === 'barkRedwood' ? 9 : 14, r()); const dark = r() < 0.55;
        const c = jitterColor(base, r, 0.25, dark ? -0.45 : 0.25);
        const pts = []; let yy = -S * 0.1, xx = x; pts.push([xx, yy]);
        while (yy < S * 1.1) { yy += lerp(18, 40, r()); xx += (r() - 0.5) * (kind === 'barkPine' ? 22 : 10); pts.push([xx, yy]); }
        wrap((dx, dy) => { g.strokeStyle = col(...c, dark ? 0.85 : 0.5); g.lineWidth = w; g.beginPath(); g.moveTo(pts[0][0] + dx, pts[0][1] + dy); for (const [px, py] of pts) g.lineTo(px + dx, py + dy); g.stroke(); });
      }
      if (kind === 'barkPine') for (let i = 0; i < 90; i++) {
        const x = r() * S, y = r() * S, w = lerp(14, 34, r()), h = lerp(40, 110, r()); const c = jitterColor(base, r, 0.2, 0.18);
        wrap((dx, dy) => { g.fillStyle = col(...c, 0.5); g.beginPath(); g.ellipse(x + dx, y + dy, w / 2, h / 2, 0, 0, TAU); g.fill(); g.strokeStyle = col(34, 26, 20, 0.55); g.lineWidth = 2; g.stroke(); });
      }
    } else if (kind === 'barkEuc' || kind === 'barkPlane') {
      const pal = kind === 'barkEuc' ? [[210, 200, 176], [168, 160, 130], [150, 150, 128], [226, 214, 190], [140, 116, 92]] : [[190, 186, 158], [128, 130, 98], [160, 150, 118], [212, 206, 180], [104, 108, 84]];
      for (let i = 0; i < 160; i++) {
        const x = r() * S, y = r() * S, w = lerp(14, 70, r()), h = lerp(kind === 'barkEuc' ? 40 : 14, kind === 'barkEuc' ? 160 : 60, r()), rot = (r() - 0.5) * 0.4;
        const c = jitterColor(pal[Math.floor(r() * pal.length)], r, 0.15);
        wrap((dx, dy) => { g.fillStyle = col(...c, 0.8); g.beginPath(); g.ellipse(x + dx, y + dy, w / 2, h / 2, rot, 0, TAU); g.fill(); });
      }
      if (kind === 'barkEuc') for (let i = 0; i < 26; i++) {
        const x = r() * S, y = r() * S, h = lerp(60, 200, r()), lw = lerp(4, 10, r());
        wrap((dx, dy) => { g.strokeStyle = col(120, 96, 70, 0.8); g.lineWidth = lw; g.beginPath(); g.moveTo(x + dx, y + dy); g.quadraticCurveTo(x + dx + 10, y + dy + h / 2, x + dx - 4, y + dy + h); g.stroke(); });
      }
    } else if (kind === 'barkPalm') {   // Canary palm: diamond leaf-base scars (the grid tiles exactly)
      const rows = 10, cols = 8;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const cx = (i + (j % 2) * 0.5) * S / cols, cy = j * S / rows; const c = jitterColor(base, r, 0.2, (r() - 0.5) * 0.3);
        wrap((dx, dy) => {
          g.fillStyle = col(...c); g.beginPath(); g.moveTo(cx + dx, cy + dy - S / rows * 0.7); g.lineTo(cx + dx + S / cols * 0.55, cy + dy); g.lineTo(cx + dx, cy + dy + S / rows * 0.7); g.lineTo(cx + dx - S / cols * 0.55, cy + dy); g.closePath(); g.fill();
          g.strokeStyle = col(58, 46, 34, 0.9); g.lineWidth = 4; g.stroke();
        });
      }
    }
    g.restore();
    // fine grain (hash of the wrapped pixel coordinate, so it tiles too)
    const img = g.getImageData(x0, y0, S, S), dd = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = (y * S + x) * 4; const n = (hash2(x, y, seed) - 0.5) * 22; dd[i] = clamp(dd[i] + n, 0, 255); dd[i + 1] = clamp(dd[i + 1] + n, 0, 255); dd[i + 2] = clamp(dd[i + 2] + n * 0.9, 0, 255); dd[i + 3] = 255; }
    g.putImageData(img, x0, y0);
  }
  function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 144665) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  // spread leaf colours into transparent pixels (alpha stays 0) so filtering never pulls in dark fringes. Works on the
  // raw RGBA arrays of the whole atlas (width AT): a canvas keeps no colour under alpha 0, so the atlas is uploaded from
  // these arrays. mask: the alpha source (defaults to d itself)
  function dilateArr(d, x0, y0, passes, mask) {
    const S = RS, m = mask || d, A = new Uint8Array(S * S), at = (x, y) => ((y0 + y) * AT + x0 + x) * 4;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) A[y * S + x] = m[at(x, y) + 3] > 8 ? 1 : 0;
    const filled = A.slice();
    for (let p = 0; p < passes; p++) {
      const next = A.slice();
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = y * S + x; if (A[i]) continue;
        let r = 0, gg = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue; if (!A[yy * S + xx]) continue; const j = at(xx, yy); r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
        if (n) { const o = at(x, y); d[o] = r / n; d[o + 1] = gg / n; d[o + 2] = b / n; next[i] = 1; }
      }
      A.set(next);
    }
    let mr = 0, mg = 0, mb = 0, mn = 0; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (filled[y * S + x]) { const o = at(x, y); mr += d[o]; mg += d[o + 1]; mb += d[o + 2]; mn++; }
    if (mn) { mr /= mn; mg /= mn; mb /= mn; }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (!A[y * S + x]) { const o = at(x, y); d[o] = mr; d[o + 1] = mg; d[o + 2] = mb; }
  }
  // tangent-space normals from a height field: h = alpha-blurred silhouette (rounded needles, knots, leaflets) plus
  // luminance (bark ridges). wrap: tileable regions (barks) sample across the edges
  function deriveNormals(c, nd, x0, y0, wrap, kA, kL) {
    const S = RS, H = new Float32Array(S * S), at = (x, y) => ((y0 + y) * AT + x0 + x) * 4;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const o = at(x, y); H[y * S + x] = (c[o + 3] / 255) * kA + ((0.2126 * c[o] + 0.7152 * c[o + 1] + 0.0722 * c[o + 2]) / 255) * kL; }
    const B = new Float32Array(S * S);                                        // 3x3 box blur softens the steps
    const hv = (x, y) => { if (wrap) { x = (x + S) % S; y = (y + S) % S; } else { x = clamp(x, 0, S - 1); y = clamp(y, 0, S - 1); } return H[y * S + x]; };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let t = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) t += hv(x + i, y + j); B[y * S + x] = t / 9; }
    const bv = (x, y) => { if (wrap) { x = (x + S) % S; y = (y + S) % S; } else { x = clamp(x, 0, S - 1); y = clamp(y, 0, S - 1); } return B[y * S + x]; };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (bv(x + 1, y) - bv(x - 1, y)) * 0.5, dy = (bv(x, y + 1) - bv(x, y - 1)) * 0.5;   // canvas space (y down)
      const nx = -dx * 16, ny = dy * 16, l = Math.hypot(nx, ny, 1);                              // texture space: v = -y
      const o = at(x, y); nd[o] = (nx / l * 0.5 + 0.5) * 255; nd[o + 1] = (ny / l * 0.5 + 0.5) * 255; nd[o + 2] = (1 / l * 0.5 + 0.5) * 255; nd[o + 3] = 255;
    }
  }
  let atlasTex = null, nrmTex = null;
  function buildAtlas() {
    if (atlasTex) return atlasTex;
    const c = document.createElement('canvas'); c.width = AT; c.height = AT; const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, AT, AT);
    const cn = document.createElement('canvas'); cn.width = AT; cn.height = AT; const gN = cn.getContext('2d', { willReadFrequently: true });
    gN.fillStyle = FLAT_N; gN.fillRect(0, 0, AT, AT);
    const at = (reg) => [(reg % 4) * RS, Math.floor(reg / 4) * RS];
    // leaf clusters (September: late-summer greens, a touch of yellowing on the plane trees)
    paintCluster(g, ...at(REG.oakLeaf), { shape: 'oak', leafL: 24, leafW: 10, perTwig: 40, twigs: 9, fill: 230, spread: 2.6, twig: [78, 64, 50], twigW: 5,
      palette: [[54, 70, 36], [62, 80, 40], [46, 62, 32], [72, 88, 46], [58, 72, 34]], gloss: 0.35 }, 11, gN);
    paintCluster(g, ...at(REG.planeLeaf), { shape: 'palmate', leafL: 44, leafW: 22, perTwig: 16, twigs: 7, fill: 60, spread: 2.4, twig: [110, 100, 76], twigW: 5,
      palette: [[92, 116, 58], [104, 128, 62], [84, 106, 50], [120, 132, 66], [132, 128, 70]], gloss: 0.2 }, 12, gN);
    paintCluster(g, ...at(REG.streetLeaf), { shape: 'oval', leafL: 32, leafW: 14, perTwig: 26, twigs: 9, fill: 110, spread: 2.6, twig: [96, 82, 64], twigW: 4,
      palette: [[98, 128, 62], [110, 140, 68], [88, 116, 54], [120, 146, 74]], gloss: 0.25 }, 13, gN);
    paintCluster(g, ...at(REG.eucLeaf), { shape: 'lance', leafL: 78, leafW: 11, perTwig: 16, twigs: 7, fill: 36, spread: 1.6, droop: 1, leafDroop: 1.0, twig: [150, 110, 80], twigW: 3,
      palette: [[112, 128, 106], [124, 138, 112], [98, 114, 92], [136, 146, 118], [104, 118, 86]], gloss: 0.3 }, 14, gN);
    paintRedwood(g, ...at(REG.redwoodSpray), 15);
    paintPine(g, ...at(REG.pineTuft), 16);
    paintCypress(g, ...at(REG.cypressClump), 17);
    paintFrond(g, ...at(REG.palmFrond), 18, false);
    paintFan(g, ...at(REG.fanLeaf), 19);
    paintFrond(g, ...at(REG.deadFrond), 20, true);
    paintBark(g, ...at(REG.barkOak), 21, 'barkOak');
    paintBark(g, ...at(REG.barkRedwood), 22, 'barkRedwood');
    paintBark(g, ...at(REG.barkEuc), 23, 'barkEuc');
    paintBark(g, ...at(REG.barkPlane), 24, 'barkPlane');
    paintBark(g, ...at(REG.barkPalm), 25, 'barkPalm');
    paintBark(g, ...at(REG.barkPine), 26, 'barkPine');
    const cd = g.getImageData(0, 0, AT, AT).data, nd = gN.getImageData(0, 0, AT, AT).data;
    // conifers and palms: normals from their rounded silhouettes; barks: from their ridges (tileable)
    for (const reg of [REG.redwoodSpray, REG.pineTuft, REG.cypressClump, REG.palmFrond, REG.fanLeaf, REG.deadFrond]) deriveNormals(cd, nd, ...at(reg), false, 0.3, 0.3);
    for (const reg of [REG.barkOak, REG.barkRedwood, REG.barkEuc, REG.barkPlane, REG.barkPalm, REG.barkPine]) deriveNormals(cd, nd, ...at(reg), true, 0, 1.0);
    for (const reg of [REG.oakLeaf, REG.planeLeaf, REG.streetLeaf, REG.eucLeaf, REG.redwoodSpray, REG.pineTuft, REG.cypressClump, REG.palmFrond, REG.fanLeaf, REG.deadFrond]) {
      dilateArr(nd, ...at(reg), 12, cd); dilateArr(cd, ...at(reg), 12);
      for (let y = 0; y < RS; y++) for (let x = 0; x < RS; x++) { const o = ((at(reg)[1] + y) * AT + at(reg)[0] + x) * 4; if (cd[o + 3] <= 8) cd[o + 3] = 0; }
    }
    const mk = (data, srgb) => { const t = new THREE.DataTexture(new Uint8Array(data.buffer), AT, AT, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.flipY = true; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
    const t = mk(cd, true); t.userData.canvas = c; nrmTex = mk(nd, false); nrmTex.userData.canvas = cn;
    atlasTex = t; return t;
  }

  // ==========================================================================================
  // TREE MODELS: procedural skeleton (bark tubes) + leaf cards, one merged geometry per species/LOD.
  // Attributes: position, normal, uv (region-local, bark tiles), aReg (atlas rect), color (AO + variation),
  // aFol (x = wind flex 0 base..1 tips, y = 1 for leaves / 0 for bark)
  // ==========================================================================================
  const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _n = new V3(), _t = new V3(), _o = new V3(), _k = new V3(), _kc = new V3();
  const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const OCT = Array.from({ length: 8 }, (_, i) => { const a = (i + 0.5) / 8 * TAU, R = 0.92 / Math.cos(Math.PI / 8); return [clamp(Math.cos(a) * R, -1, 1), clamp(Math.sin(a) * R, -1, 1)]; });
  const OCT_REGS = new Set([REG.oakLeaf, REG.planeLeaf, REG.streetLeaf, REG.eucLeaf, REG.pineTuft, REG.cypressClump]);
  class Builder {
    constructor(H, crown) { this.P = []; this.N = []; this.UV = []; this.R = []; this.C = []; this.F = []; this.I = []; this.H = H; this.crown = crown; }   // crown: [cx, cy, cz, rx, ry, rz]
    get vcount() { return this.P.length / 3; }
    ao(p) {   // crown-interior occlusion (0.5 deep inside .. 1 on the surface) x bottom shade
      const [cx, cy, cz, rx, ry, rz] = this.crown;
      const e = Math.sqrt(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 + ((p.z - cz) / rz) ** 2);
      const surf = clamp((e - 0.25) / 0.75, 0, 1); const hv = clamp((p.y - (cy - ry)) / (2 * ry), 0, 1);
      return lerp(0.55, 1.0, surf * surf * (3 - 2 * surf)) * lerp(0.74, 1.0, hv);
    }
    vert(p, n, u, v, reg, shade, flex, leaf) {
      this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z); this.UV.push(u, v); this.R.push(reg[0], reg[1], reg[2], reg[3]);
      this.C.push(shade, shade, shade); this.F.push(flex, leaf);
    }
    // tapered tube through points pts (V3[]) with radii rad[]; bark region; tex repeat per metre
    tube(pts, rad, sides, regIdx, opts = {}) {
      const reg = regionUV(regIdx); const base = this.vcount; const n = pts.length;
      let prevN = null; let vAcc = 0;
      for (let i = 0; i < n; i++) {
        const p = pts[i]; const tng = _t.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
        let nrm; if (!prevN) { nrm = Math.abs(tng.y) < 0.95 ? new V3(0, 1, 0).cross(tng).normalize() : new V3(1, 0, 0).cross(tng).normalize(); }
        else { nrm = prevN.clone().sub(tng.clone().multiplyScalar(prevN.dot(tng))).normalize(); }
        prevN = nrm; const bin = new V3().crossVectors(tng, nrm).normalize();
        if (i > 0) vAcc += pts[i].distanceTo(pts[i - 1]);
        const circ = TAU * Math.max(0.03, rad[i]); const uRep = Math.max(1, Math.round(circ / (opts.texM || 1.2)));
        for (let s = 0; s <= sides; s++) {
          const a = s / sides * TAU; const ca = Math.cos(a), sa = Math.sin(a);
          _n.set(nrm.x * ca + bin.x * sa, nrm.y * ca + bin.y * sa, nrm.z * ca + bin.z * sa);
          _a.copy(p).addScaledVector(_n, rad[i]);
          const shade = (opts.ao !== undefined ? opts.ao : 1) * lerp(0.62, 1, clamp(p.y / (this.H * 0.35), 0, 1)) * (0.92 + 0.16 * Math.abs(Math.sin(a * 2.3 + i)));
          const flex = clamp(p.y / this.H, 0, 1) ** 2 * (opts.flexMul || 1);
          this.vert(_a, _n, s / sides * uRep, vAcc / (opts.texM || 1.2), reg, shade, flex, 0);
        }
      }
      for (let i = 0; i < n - 1; i++) for (let s = 0; s < sides; s++) {
        const a = base + i * (sides + 1) + s, b = a + 1, c = a + sides + 1, d = c + 1;
        this.I.push(a, c, b, b, c, d);
      }
    }
    // leaf card: centre, half-extent vectors (right r, up u), card normal cn, region; lighting normal blends to the crown direction
    card(center, r, u, cn, regIdx, opts = {}) {
      const reg = regionUV(regIdx); const base = this.vcount; const [cx, cy, cz] = this.crown;
      const cv = 0.9 + 0.2 * (((Math.sin(center.x * 12.9898 + center.y * 78.233 + center.z * 37.719) * 43758.5453) % 1 + 1) % 1);
      const flipU = (((Math.sin(center.x * 3.1 + center.z * 5.7) * 9173.13) % 1 + 1) % 1) < 0.5;
      // round clusters (painted inside a circle of radius 0.46) use an octagon: ~30% fewer shaded fragments than a quad
      const oct = OCT_REGS.has(regIdx);
      const corners = oct ? OCT : QUAD;
      const cb = opts.crownBlend !== undefined ? opts.crownBlend : 0.78;
      // shell cards know their clump: lighting normals bend around the clump as well as the crown, and the clump's
      // inner side is darker, so a crown reads as lit and shaded clusters instead of one smooth ball
      const cl = opts.clump;
      if (cl) _kc.set((cl.x - cx) / (this.crown[3] * this.crown[3]), (cl.y - cy) / (this.crown[4] * this.crown[4]), (cl.z - cz) / (this.crown[5] * this.crown[5])).normalize();
      for (const [sr, su] of corners) {
        _a.copy(center).addScaledVector(r, sr).addScaledVector(u, su);
        _o.set((_a.x - cx) / (this.crown[3] * this.crown[3]), (_a.y - cy) / (this.crown[4] * this.crown[4]), (_a.z - cz) / (this.crown[5] * this.crown[5])).normalize();
        let side = 1;
        if (cl) { _k.subVectors(_a, cl); const kl = _k.length(); if (kl > 1e-3) { _k.multiplyScalar(1 / kl); side = 0.5 + 0.5 * _k.dot(_kc); _o.multiplyScalar(0.45).addScaledVector(_k, 0.55).normalize(); } }
        _n.copy(cn).multiplyScalar(1 - cb).addScaledVector(_o, cb).normalize();
        const shade = this.ao(_a) * (opts.shade || 1) * cv * lerp(0.7, 1.0, side);
        const flex = Math.max(0.45, clamp(_a.y / this.H, 0, 1) ** 1.5);
        const uu = (sr + 1) / 2, vv = (su + 1) / 2;
        this.vert(_a, _n, lerp(0.008, 0.992, flipU ? 1 - uu : uu), lerp(0.008, 0.992, vv), reg, shade, flex, 1);
      }
      if (oct) for (let k = 1; k < 7; k++) this.I.push(base, base + k, base + k + 1);
      else this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // curved ribbon (palm frond): points along the midrib, width w(u), side vector per point, V-fold
    ribbon(pts, widths, sides, fold, regIdx, opts = {}) {
      const reg = regionUV(regIdx); const [cx, cy, cz] = this.crown; const n = pts.length;
      const base = this.vcount;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        for (let k = 0; k < 3; k++) {   // left edge, midrib, right edge
          const sgn = k - 1; const w = widths[i];
          _a.copy(pts[i]).addScaledVector(sides[i], sgn * w); _a.y += Math.abs(sgn) * fold * w;
          _o.set(_a.x - cx, (_a.y - cy) * 1.2, _a.z - cz).normalize();
          _n.set(0, 1, 0).lerp(_o, 0.6).normalize();
          const shade = (opts.shade || 1) * lerp(0.7, 1.0, u) * (k === 1 ? 0.92 : 1);
          this.vert(_a, _n, lerp(0.02, 0.98, u), k === 0 ? 0.02 : k === 1 ? 0.5 : 0.98, reg, shade, Math.max(0.5, clamp(pts[i].y / this.H, 0, 1)), 1);
        }
      }
      for (let i = 0; i < n - 1; i++) for (let k = 0; k < 2; k++) {
        const a = base + i * 3 + k, b = a + 1, c = a + 3, d = c + 1;
        this.I.push(a, b, c, b, d, c);
      }
    }
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
      g.setAttribute('aReg', new THREE.Float32BufferAttribute(this.R, 4));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
      g.setAttribute('aFol', new THREE.Float32BufferAttribute(this.F, 2));
      g.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
  }
  // a gently curved branch from p0 in direction d0 toward target (or length len), bending by `bend` (up +, droop -)
  function branchPts(p0, d0, len, segs, bend, r, wobble = 0.12) {
    const pts = [p0.clone()]; const d = d0.clone().normalize(); const p = p0.clone();
    for (let i = 1; i <= segs; i++) {
      d.x += (r() - 0.5) * wobble; d.z += (r() - 0.5) * wobble; d.y += bend / segs + (r() - 0.5) * wobble * 0.5; d.normalize();
      p.addScaledVector(d, len / segs); pts.push(p.clone());
    }
    return pts;
  }
  const radii = (n, r0, r1, pow = 1) => Array.from({ length: n }, (_, i) => lerp(r0, r1, Math.pow(i / Math.max(1, n - 1), pow)));
  function basis(nrm, r, twist) {   // orthonormal (right, up) spanning the plane perpendicular to nrm, rotated by twist
    const ref = Math.abs(nrm.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    const rt = new V3().crossVectors(ref, nrm).normalize(), up = new V3().crossVectors(nrm, rt).normalize();
    const c = Math.cos(twist), s = Math.sin(twist);
    return [rt.clone().multiplyScalar(c).addScaledVector(up, s), up.clone().multiplyScalar(c).addScaledVector(rt, -s)];
  }
  // cards whose bottom edge sits on the branch point and which reach outward (so twigs in the texture meet the branch)
  function attachedCard(B, at, outward, size, regIdx, r, o = {}) {
    const out = outward.clone().normalize();
    const nrm = new V3((r() - 0.5) * 1.2, 0.55 + (o.up || 0), (r() - 0.5) * 1.2).addScaledVector(out, 0.9).normalize();
    // 'up' of the card = outward direction projected onto the card plane (texture twigs grow toward +v)
    const upv = out.clone().sub(nrm.clone().multiplyScalar(out.dot(nrm))); if (upv.lengthSq() < 1e-4) upv.set(0, 1, 0); upv.normalize();
    if (o.hang) { upv.set(0, -1, 0).addScaledVector(out, 0.35).normalize(); }
    const rt = new V3().crossVectors(upv, nrm).normalize();
    const w = size * (o.aspect || 1) * 0.5, h = size * 0.5;
    const ctr = at.clone().addScaledVector(upv, h * 0.82);
    B.card(ctr, rt.multiplyScalar(w), upv.multiplyScalar(h), nrm, regIdx, o);
  }
  // surface-fill card inside the crown shell, facing outward
  function shellCard(B, pos, size, regIdx, r, o = {}) {
    const [cx, cy, cz] = B.crown;
    const out = new V3(pos.x - cx, (pos.y - cy) * (o.flatten || 1), pos.z - cz).normalize();
    const nrm = out.clone().add(new V3((r() - 0.5) * 0.9, 0.35 + (r() - 0.5) * 0.5, (r() - 0.5) * 0.9)).normalize();
    const [rt, up] = basis(nrm, r, r() * TAU);
    if (o.hang) { up.set(0, -1, 0).addScaledVector(out, 0.3).normalize(); rt.crossVectors(up, nrm).normalize(); }
    B.card(pos, rt.multiplyScalar(size * (o.aspect || 1) * 0.5), up.multiplyScalar(size * 0.5), nrm, regIdx, o);
  }
  // point in the crown ellipsoid shell [inner..1] of the radii
  function shellPoint(B, r, inner, yLo = -1, yHi = 1) {
    const [cx, cy, cz, rx, ry, rz] = B.crown;
    for (let k = 0; k < 20; k++) {
      const u = r() * 2 - 1, th = r() * TAU, s = Math.sqrt(1 - u * u);
      if (u < yLo || u > yHi) continue;
      const d = lerp(inner, 1, Math.pow(r(), 0.6));
      return new V3(cx + s * Math.cos(th) * rx * d, cy + u * ry * d, cz + s * Math.sin(th) * rz * d);
    }
    return new V3(cx, cy, cz);
  }

  // ------------------------------------------------------------------ broadleaf (oak, plane/sycamore, street, eucalyptus)
  function broadleaf(p, seed) {
    const r = rng(seed); const B = new Builder(p.H, p.crown); const [cx, cy, cz, rx, ry, rz] = p.crown;
    const trunkTop = new V3((r() - 0.5) * p.lean, p.trunkH, (r() - 0.5) * p.lean);
    const tpts = branchPts(new V3(0, 0, 0), trunkTop.clone().normalize(), p.trunkH, 5, 0, r, 0.05);
    const skeleton = [{ pts: tpts, rad: radii(tpts.length, p.trunkR, p.trunkR * 0.62, 0.8), level: 0 }];
    const tips = [];
    for (let i = 0; i < p.limbs; i++) {
      const az = i * 2.39996 + r() * 0.6, el = lerp(p.limbEl[0], p.limbEl[1], r());
      const attachY = p.trunkH * lerp(p.attach[0], p.attach[1], r());
      const a = tpts[Math.min(tpts.length - 1, Math.round(attachY / p.trunkH * (tpts.length - 1)))].clone();
      // aim at a point on the crown envelope
      const tgt = new V3(cx + Math.cos(az) * Math.cos(el) * rx * 0.92, cy + Math.sin(el) * ry * 0.9, cz + Math.sin(az) * Math.cos(el) * rz * 0.92);
      const dir = tgt.clone().sub(a); const len = dir.length() * lerp(0.7, 0.85, r());
      const lp = branchPts(a, dir, len, 6, p.limbBend, r, 0.18);
      skeleton.push({ pts: lp, rad: radii(lp.length, p.trunkR * p.limbR, p.trunkR * p.limbR * 0.28, 0.9), level: 1 });
      for (let j = 0; j < p.twigs; j++) {
        const f = lerp(0.35, 1.0, r()); const k = Math.min(lp.length - 1, Math.max(1, Math.round(f * (lp.length - 1))));
        const b0 = lp[k].clone(); const d0 = tgt.clone().sub(a).normalize().add(new V3(r() - 0.5, (r() - 0.3) * 0.8, r() - 0.5).multiplyScalar(1.3)).normalize();
        const bl = len * lerp(0.28, 0.5, r());
        const bp = branchPts(b0, d0, bl, 2, p.twigBend, r, 0.3);
        skeleton.push({ pts: bp, rad: radii(bp.length, p.trunkR * p.limbR * 0.3, 0.02, 1), level: 2 });
        tips.push(bp);
      }
    }
    for (const s of skeleton) B.tube(s.pts, s.rad, s.level === 0 ? 9 : s.level === 1 ? 6 : 3, p.bark, { texM: s.level ? 0.9 : 1.4 });
    // leaves: attached along twig tips + shell fill for a full silhouette
    const cards = [];
    for (const bp of tips) for (let k = 0; k < p.perTwig; k++) {
      const f = lerp(0.35, 1, r()); const i = Math.min(bp.length - 2, Math.floor(f * (bp.length - 1)));
      const at = bp[i].clone().lerp(bp[i + 1], r()); const out = at.clone().sub(new V3(cx, cy - ry * 0.3, cz));
      const e = Math.hypot((at.x - cx) / rx, (at.y - cy) / ry, (at.z - cz) / rz); if (e < 0.58 || e > 1.04) continue;   // hidden deep inside / standing out of the crown
      cards.push(['att', at, out, p.leafSize * lerp(0.8, 1.2, r())]);
    }
    const nClumps = p.clumps || 12, cr = Math.min(rx, ry) * (p.clumpR || 0.34);
    // clump centres: a third on the crown's upper cap (so crowns stay closed from the air), the rest anywhere on the shell
    const clumps = []; for (let c = 0; c < nClumps; c++) clumps.push(shellPoint(B, r, 0.8, c % 3 === 0 ? 0.45 : p.shellY[0], p.shellY[1]));
    clumps.push(new V3(cx, cy + ry * 0.82, cz));
    for (let k = 0; k < Math.round(p.shell * 0.85); k++) {
      const c = clumps[k % nClumps]; const g = () => (r() + r() + r() - 1.5) * 1.15;
      const pt = new V3(c.x + g() * cr, c.y + g() * cr * 0.8, c.z + g() * cr);
      const e = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry, (pt.z - cz) / rz); if (e > 1.06) pt.sub(new V3(cx, cy, cz)).multiplyScalar(1.06 / e).add(new V3(cx, cy, cz));
      cards.push(['shell', pt, c, p.leafSize * lerp(0.85, 1.25, r())]);   // (the third slot: the clump centre)
    }
    return { B, cards, skeleton, p, r };
  }
  function emitCards(B, cards, p, r, every = 1, grow = 1) {
    for (let i = 0; i < cards.length; i += every) {
      const [kind, at, out, size] = cards[i];
      if (kind === 'att') attachedCard(B, at, out, size * grow, p.leaf, r, { hang: p.hang, aspect: p.aspect, up: p.leafUp });
      else shellCard(B, at, size * grow, p.leaf, r, { hang: p.hang, aspect: p.aspect, flatten: p.flatten, clump: out });
    }
  }

  // ------------------------------------------------------------------ species
  const SPECIES = {
    oak: { H: 9.5, R: 7.0, trunkH: 2.0, trunkR: 0.46, lean: 1.2, limbs: 7, limbEl: [-0.3, 0.45], attach: [0.7, 1.0], limbR: 0.6, limbBend: 0.15, twigs: 5, twigBend: 0.05,
      perTwig: 7, shell: 190, shellInner: 0.72, shellY: [-0.5, 1], leafSize: 1.9, leaf: REG.oakLeaf, bark: REG.barkOak, crown: [0, 5.6, 0, 7.0, 3.5, 7.0], flatten: 1.5, clumps: 14, clumpR: 0.42 },
    sycamore: { H: 17, R: 6.8, trunkH: 5.8, trunkR: 0.38, lean: 0.6, limbs: 6, limbEl: [0.1, 1.0], attach: [0.6, 1.0], limbR: 0.5, limbBend: 0.35, twigs: 5, twigBend: 0.15,
      perTwig: 7, shell: 150, shellInner: 0.7, shellY: [-0.6, 1], leafSize: 2.1, leaf: REG.planeLeaf, bark: REG.barkPlane, crown: [0, 11.2, 0, 6.6, 5.6, 6.6] },
    street: { H: 8, R: 3.6, trunkH: 2.6, trunkR: 0.14, lean: 0.3, limbs: 5, limbEl: [0.25, 1.1], attach: [0.8, 1.0], limbR: 0.55, limbBend: 0.3, twigs: 4, twigBend: 0.2,
      perTwig: 6, shell: 80, shellInner: 0.65, shellY: [-0.6, 1], leafSize: 1.35, leaf: REG.streetLeaf, bark: REG.barkPlane, crown: [0, 5.3, 0, 3.5, 2.8, 3.5] },
    eucalyptus: { H: 32, R: 7, trunkH: 14, trunkR: 0.62, lean: 1.6, limbs: 5, limbEl: [0.3, 1.25], attach: [0.7, 1.0], limbR: 0.45, limbBend: 0.3, twigs: 6, twigBend: -0.5,
      perTwig: 6, shell: 120, shellInner: 0.55, shellY: [-0.7, 1], leafSize: 2.3, leaf: REG.eucLeaf, bark: REG.barkEuc, crown: [0.4, 24, 0, 6.6, 8.2, 6.6], hang: true, aspect: 0.7 },
    // multi-stemmed evergreen shrub (oleander / pittosporum hedges along the right of way)
    shrub: { H: 2.8, R: 1.8, trunkH: 0.22, trunkR: 0.07, lean: 0.25, limbs: 8, limbEl: [0.55, 1.35], attach: [0.3, 1.0], limbR: 0.7, limbBend: 0.25, twigs: 3, twigBend: 0.15,
      perTwig: 6, shell: 110, shellInner: 0.55, shellY: [-0.8, 1], leafSize: 0.95, leaf: REG.streetLeaf, bark: REG.barkPlane, crown: [0, 1.45, 0, 1.75, 1.3, 1.75], clumps: 9, clumpR: 0.5, flatten: 1.2 },
  };
  function buildBroadleaf(kind, lod, seed) {
    const p = SPECIES[kind]; const { B, cards, skeleton, r } = broadleaf(p, seed);
    if (lod === 0) { emitCards(B, cards, p, r); return B; }
    // mid: trunk + limbs with fewer sides, a fifth of the cards (each ~2.2x bigger)
    const M = new Builder(p.H, p.crown);
    for (const s of skeleton) if (s.level <= 1) M.tube(s.pts.filter((_, i) => i % 3 === 0 || i === s.pts.length - 1), s.rad.filter((_, i) => i % 3 === 0 || i === s.rad.length - 1), s.level ? 3 : 5, p.bark, { texM: 1.6 });
    emitCards(M, cards, p, r, 8, 2.75);
    return M;
  }

  // ------------------------------------------------------------------ conifers
  function buildRedwood(lod, seed) {   // coast redwood: straight trunk, bare below, dense narrow cone of drooping sprays
    const r = rng(seed); const H = 34, y0 = 8.5, crown = [0, 21, 0, 5.0, 13.5, 5.0]; const B = new Builder(H, crown);
    const tp = branchPts(new V3(0, 0, 0), new V3(0.015, 1, 0), H * 0.98, 8, 0, r, 0.015);
    B.tube(tp, radii(tp.length, 1.1, 0.07, 0.65), lod ? 6 : 12, REG.barkRedwood, { texM: 1.8 });
    B.tube([new V3(0, -0.3, 0), new V3(0, 1.2, 0)], [1.55, 1.12], lod ? 6 : 12, REG.barkRedwood, { texM: 1.2 });   // buttress flare
    const whorls = lod ? 10 : 26;
    for (let w = 0; w < whorls; w++) {
      const u = w / (whorls - 1), y = lerp(y0, H * 0.97, u);
      const Lb = lerp(5.2, 0.6, Math.pow(u, 0.9)) * lerp(0.85, 1.12, r());
      const nb = lod ? 3 : 5;
      for (let k = 0; k < nb; k++) {
        const az = (k / nb) * TAU + w * 2.4 + r() * 0.4;
        const out = new V3(Math.cos(az), 0, Math.sin(az));
        const d = new V3(out.x, lerp(-0.35, 0.1, u) + (r() - 0.5) * 0.15, out.z);
        const bp = branchPts(new V3(0, y, 0), d, Lb, 2, -0.3, r, 0.08);
        if (!lod && w % 2 === 0 && Lb > 1.5) B.tube(bp, radii(bp.length, 0.1 * (1 - u * 0.5), 0.025), 3, REG.barkRedwood, { texM: 0.8 });
        const nsp = lod ? 1 : Math.max(2, Math.round(Lb / 0.9));
        for (let s2 = 0; s2 < nsp; s2++) {
          const f = lod ? 0.5 : (s2 + 0.5) / nsp;
          const at = bp[0].clone().lerp(bp[bp.length - 1], f);
          const along = out.clone();
          const len = lod ? Lb * 1.3 + 1 : lerp(1.6, 2.6, r()), wid = lod ? 2.2 : lerp(1.1, 1.5, r());
          const tilt = -0.35 - 0.3 * f;
          const dirv = new V3(along.x * Math.cos(tilt), Math.sin(tilt), along.z * Math.cos(tilt));
          const side = new V3(-along.z, 0, along.x);
          const nrm = new V3().crossVectors(dirv, side).normalize(); if (nrm.y < 0) nrm.negate();
          B.card(at.clone().addScaledVector(dirv, len * 0.4), dirv.clone().multiplyScalar(len * 0.5), side.clone().multiplyScalar(wid * 0.5), nrm, REG.redwoodSpray, { crownBlend: 0.7 });
        }
      }
    }
    for (let k = 0; k < (lod ? 16 : 70); k++) {   // hanging sprays filling the surface of the cone
      const u = r(); const y = lerp(y0 + 1, H * 0.95, u); const rad = lerp(5.0, 0.5, Math.pow(u, 0.9)) * lerp(0.7, 1.0, r());
      const az = r() * TAU; const pos = new V3(Math.cos(az) * rad, y, Math.sin(az) * rad);
      shellCard(B, pos, (lod ? 3.4 : 2.2) * lerp(0.8, 1.2, r()), REG.redwoodSpray, r, { hang: true, aspect: 1.2 });
    }
    return B;
  }
  function buildPine(lod, seed) {
    const r = rng(seed); const H = 20, crown = [0, 14.5, 0, 6.2, 5.2, 6.2]; const B = new Builder(H, crown);
    const tp = branchPts(new V3(0, 0, 0), new V3(0.1, 1, 0.05), H * 0.92, 6, 0, r, 0.06);
    B.tube(tp, radii(tp.length, 0.5, 0.12, 0.8), lod ? 5 : 9, REG.barkPine, { texM: 1.2 });
    const nb = lod ? 8 : 16;
    for (let k = 0; k < nb; k++) {
      const y = lerp(8.5, 17.5, r()); const az = k * 2.39996; const d = new V3(Math.cos(az), 0.25 + 0.4 * r(), Math.sin(az));
      const L = lerp(3.5, 6.2, r()) * (1 - Math.abs(y - 13) / 14);
      const bp = branchPts(new V3(0, y, 0), d, L, 4, 0.4, r, 0.25);
      B.tube(bp, radii(bp.length, 0.18, 0.04), lod ? 3 : 5, REG.barkPine, { texM: 0.8 });
      const tufts = lod ? 3 : 9;
      for (let t = 0; t < tufts; t++) {
        const f = lerp(0.3, 1, r()); const at = bp[0].clone().lerp(bp[bp.length - 1], f).add(new V3((r() - 0.5) * 1.2, (r() - 0.3) * 1.0, (r() - 0.5) * 1.2));
        shellCard(B, at, (lod ? 3.2 : 1.9) * lerp(0.8, 1.2, r()), REG.pineTuft, r, {});
      }
    }
    for (let k = 0; k < (lod ? 10 : 60); k++) shellCard(B, shellPoint(B, r, 0.7, -0.4, 1), (lod ? 3.4 : 2.0) * lerp(0.8, 1.2, r()), REG.pineTuft, r, {});
    return B;
  }
  function buildCypress(lod, seed) {   // Monterey cypress: gnarled leaning trunk, flat wind-swept plates, flat top
    const r = rng(seed); const H = 15, crown = [1.5, 10.5, 0, 7.2, 3.8, 6.0]; const B = new Builder(H, crown);
    const tp = branchPts(new V3(0, 0, 0), new V3(0.35, 1, 0.1), 7, 5, 0, r, 0.1);
    B.tube(tp, radii(tp.length, 0.6, 0.34, 0.8), lod ? 5 : 8, REG.barkOak, { texM: 1.2 });
    const limbs = lod ? 4 : 7; const plates = [];
    for (let k = 0; k < limbs; k++) {
      const az = k * 2.39996 + 0.3; const d = new V3(Math.cos(az) * 1.2 + 0.4, 0.55 + 0.3 * r(), Math.sin(az));
      const a = tp[Math.min(tp.length - 1, 2 + Math.floor(r() * (tp.length - 2)))].clone();
      const bp = branchPts(a, d, lerp(4, 7.5, r()), 4, 0.2, r, 0.3);
      B.tube(bp, radii(bp.length, 0.26, 0.06), lod ? 3 : 5, REG.barkOak, { texM: 0.8 });
      plates.push(bp[bp.length - 1], bp[Math.floor(bp.length / 2)]);
    }
    for (const pt of plates) {
      const np = lod ? 2 : 7;
      for (let k = 0; k < np; k++) {
        const at = pt.clone().add(new V3((r() - 0.5) * 3.4, (r() - 0.5) * 0.9 + 0.4, (r() - 0.5) * 3.0));
        const nrm = new V3((r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5).normalize(); const [rt, up] = basis(nrm, r, r() * TAU);
        const s = (lod ? 5.2 : 3.0) * lerp(0.8, 1.2, r());
        B.card(at, rt.multiplyScalar(s * 0.6), up.multiplyScalar(s * 0.42), nrm, REG.cypressClump, { crownBlend: 0.55 });
      }
    }
    for (let k = 0; k < (lod ? 14 : 90); k++) shellCard(B, shellPoint(B, r, 0.55, -0.55, 1), (lod ? 4.6 : 2.7) * lerp(0.8, 1.2, r()), REG.cypressClump, r, { flatten: 1.7 });
    return B;
  }

  // ------------------------------------------------------------------ palms
  function buildPalm(lod, seed) {   // Canary Island date palm
    const r = rng(seed); const H = 13.5, trunkH = 10.2, crown = [0, 12.2, 0, 5.2, 3.2, 5.2]; const B = new Builder(H, crown);
    const tp = branchPts(new V3(0, 0, 0), new V3(0.03, 1, 0), trunkH, 6, 0, r, 0.02);
    const tr = tp.map((p, i) => 0.58 - 0.06 * Math.sin(i / (tp.length - 1) * Math.PI));
    B.tube(tp, tr, lod ? 6 : 12, REG.barkPalm, { texM: 1.1, ao: 0.95 });
    const top = tp[tp.length - 1];
    B.tube([top, top.clone().add(new V3(0, 1.1, 0))], [0.75, 0.5], lod ? 6 : 10, REG.barkPalm, { texM: 0.8, ao: 0.8 });
    const n = lod ? 16 : 56; const head = top.clone().add(new V3(0, 1.0, 0));
    for (let i = 0; i < n; i++) {
      const th = i * 2.39996, row = (i * 7) % 4, el = [1.25, 0.85, 0.4, -0.05][row] + (r() - 0.5) * 0.25;
      const L = lerp(5.6, 6.8, r()) - row * 0.2, segs = lod ? 3 : 7, droop = [1.0, 1.25, 1.35, 1.2][row];
      const pts = [], sides = [], widths = [];
      const dir = new V3(Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el));
      const side = new V3(-Math.sin(th), 0, Math.cos(th));
      for (let s = 0; s <= segs; s++) {
        const u = s / segs; const e = el - droop * u * u;
        pts.push(head.clone().add(new V3(Math.cos(th) * Math.cos(e) * L * u, Math.sin(e) * L * u - droop * 0.3 * u * u * L * 0.25, Math.sin(th) * Math.cos(e) * L * u)));
        sides.push(side); widths.push((lod ? 1.1 : 0.8) * Math.sin(Math.PI * Math.min(1, 0.1 + u * 0.95)) + 0.04);
      }
      void dir; B.ribbon(pts, widths, sides, 0.35, REG.palmFrond, {});
    }
    return B;
  }
  function buildFanPalm(lod, seed) {   // Mexican fan palm: very tall slender trunk, skirt of dead fronds, ball of fans
    const r = rng(seed); const H = 23, trunkH = 20.5, crown = [0.5, 21.4, 0, 2.4, 2.0, 2.4]; const B = new Builder(H, crown);
    const tp = branchPts(new V3(0, 0, 0), new V3(0.05, 1, 0.02), trunkH, 6, 0.02, r, 0.01);
    B.tube(tp, radii(tp.length, 0.33, 0.22, 1), lod ? 5 : 8, REG.barkPine, { texM: 1.0 });
    const top = tp[tp.length - 1];
    // skirt: hanging dead fronds around the upper trunk
    const ns = lod ? 6 : 16;
    for (let i = 0; i < ns; i++) {
      const th = i / ns * TAU + r() * 0.2; const out = new V3(Math.cos(th), 0, Math.sin(th));
      const at = top.clone().add(new V3(out.x * 0.45, -1.1 - r() * 0.5, out.z * 0.45));
      const up = new V3(0, 1, 0), rt = new V3().crossVectors(up, out).normalize();
      B.card(at, rt.multiplyScalar(0.55), up.multiplyScalar(1.3), out, REG.deadFrond, { crownBlend: 0.4, shade: 0.8 });
    }
    const nf = lod ? 9 : 26;
    for (let i = 0; i < nf; i++) {
      const th = i * 2.39996, el = -0.5 + 1.7 * ((i * 0.618) % 1);
      const dir = new V3(Math.cos(el) * Math.cos(th), Math.sin(el), Math.cos(el) * Math.sin(th));
      const L = 1.3 + 0.5 * r(); const e = top.clone().addScaledVector(dir, L);
      if (!lod) B.tube([top.clone(), e.clone()], [0.04, 0.03], 3, REG.barkPine, { texM: 0.5 });
      const nrm = dir.clone(); const upv = new V3(0, 1, 0).sub(nrm.clone().multiplyScalar(nrm.y)); if (upv.lengthSq() < 1e-3) upv.set(1, 0, 0); upv.normalize();
      const rt = new V3().crossVectors(upv, nrm).normalize(); const s = (lod ? 1.6 : 1.2) * lerp(0.9, 1.1, r());
      B.card(e.clone().addScaledVector(upv, s * 0.56), rt.multiplyScalar(s), upv.multiplyScalar(s), nrm, REG.fanLeaf, { crownBlend: 0.5 });
    }
    return B;
  }
  const BUILD = {
    oak: (lod, s) => buildBroadleaf('oak', lod, s), sycamore: (lod, s) => buildBroadleaf('sycamore', lod, s), street: (lod, s) => buildBroadleaf('street', lod, s),
    eucalyptus: (lod, s) => buildBroadleaf('eucalyptus', lod, s), redwood: buildRedwood, pine: buildPine, cypress: buildCypress, palm: buildPalm, fanpalm: buildFanPalm,
    shrub: (lod, s) => buildBroadleaf('shrub', lod, s),
  };
  // model reference dimensions (height, crown radius) used to scale instances to the data
  const DIM = { oak: [9.5, 7.0], redwood: [34, 5.0], eucalyptus: [32, 6.8], palm: [13.5, 5.3], sycamore: [17, 6.7], cypress: [15, 6.5], pine: [20, 6.2], street: [8, 3.6], fanpalm: [23, 2.5], shrub: [2.8, 1.8] };

  // ==========================================================================================
  // MATERIALS: one foliage material for every species/LOD (atlas via aReg), wind in the vertex shader,
  // alpha-sharpened leaf cutouts (stable coverage across mips), leaf translucency against the sun,
  // no back-face normal flip (leaf cards are lit by their crown normals from both sides)
  // ==========================================================================================
  const uFol = { uFolAtlas: { value: null }, uFolNrm: { value: null }, uFolTime: U.uTime, uFolWind: U.uWind, uFolNight: U.uNight, uFolFade: { value: new THREE.Vector4(0, 1e9, 0, 0) } };
  const FOL_VHEAD = `
    attribute vec4 aReg; attribute vec2 aFol;
    uniform float uFolTime; uniform float uFolWind;
    varying vec4 vFolReg; varying vec2 vFolUv; varying float vFolLeaf;
    void folWind(inout vec3 p) {
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz; mat3 im = mat3(instanceMatrix);
      #else
        vec3 ip = vec3(0.0); mat3 im = mat3(1.0);
      #endif
      float sc = sqrt(max(1e-6, dot(im[1], im[1])));
      float ph = ip.x * 0.061 + ip.z * 0.047;
      float w = uFolWind;
      float t = uFolTime;
      float sway = sin(t * 0.72 + ph) * 0.6 + sin(t * 1.63 + ph * 1.7) * 0.3 + sin(t * 3.1 + ph * 2.9) * 0.1;
      vec3 dirL = transpose(im) * normalize(vec3(0.88, 0.0, 0.47));
      dirL /= max(1e-4, dot(dirL, dirL));
      float f = aFol.x;
      p += dirL * sway * (0.04 + 0.32 * w) * f * (0.5 + 0.05 * p.y);
      // leaf flutter, continuous in position so card corners move coherently
      float tt = t * (4.5 + 3.0 * w) + ph * 7.0;
      vec3 fl = vec3(sin(tt + p.y * 2.1 + p.z * 1.7), 0.7 * sin(tt * 1.13 + p.x * 1.9 + p.z * 2.3), sin(tt * 0.91 + p.x * 1.3 + p.y * 1.9));
      p += fl * aFol.y * (0.015 + 0.05 * w) / max(0.4, sc);
    }
  `;
  const FOL_FHEAD = `
    uniform sampler2D uFolAtlas; varying vec4 vFolReg; varying vec2 vFolUv; varying float vFolLeaf;
    vec4 folSample() {
      vec2 f = fract(vFolUv);
      vec2 uv = vFolReg.xy + f * vFolReg.zw;
      vec2 gx = dFdx(vFolUv) * vFolReg.zw, gy = dFdy(vFolUv) * vFolReg.zw;
      vec4 c = textureGrad(uFolAtlas, uv, gx, gy);
      // mip-aware alpha sharpening: keeps leaf coverage stable in the distance, crisp edges up close
      vec2 px = vec2(${AT}.0);
      float lod = max(0.0, 0.5 * log2(max(dot(gx * px, gx * px), dot(gy * px, gy * px))));
      c.a *= 1.0 + lod * 0.28;
      return c;
    }
  `;
  // per-leaf tilt and fold, bark ridges: the normal atlas in the card's own tangent frame (from screen derivatives),
  // added to the crown-blended lighting normal
  const FOL_NRM = `
    uniform sampler2D uFolNrm;
    vec3 folPerturb(vec3 n) {
      vec2 f = fract(vFolUv); vec2 uv = vFolReg.xy + f * vFolReg.zw;
      vec2 gx = dFdx(vFolUv) * vFolReg.zw, gy = dFdy(vFolUv) * vFolReg.zw;
      vec3 t = textureGrad(uFolNrm, uv, gx, gy).xyz * 2.0 - 1.0;
      vec3 dp1 = dFdx(vViewPosition), dp2 = dFdy(vViewPosition); vec2 du1 = dFdx(vFolUv), du2 = dFdy(vFolUv);
      vec3 N0 = normalize(cross(dp1, dp2)), p2 = cross(dp2, N0), p1 = cross(N0, dp1);
      vec3 T = p2 * du1.x + p1 * du2.x, B = p2 * du1.y + p1 * du2.y;
      float im = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-24));
      return normalize(n + (T * t.x + B * t.y) * im * mix(1.3, 0.9, vFolLeaf));
    }
  `;
  const FOL_TRANSLUCENT = `
    void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
      RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
      float back = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 );
      float thru = saturate( dot( -geometryNormal, directLight.direction ) );
      // light through a leaf is filtered by chlorophyll: yellow-green whatever the colour of its surface (pale
      // eucalyptus leaves glowed white against the sun)
      vec3 tc = vec3( 0.5, 0.72, 0.14 ) * min( 0.2 + 3.5 * dot( material.diffuseColor, vec3( 0.3, 0.59, 0.11 ) ), 0.75 );
      reflectedLight.directDiffuse += directLight.color * tc * vFolLeaf * ( back * 0.4 + thru * 0.2 );
    }
    #undef RE_Direct
    #define RE_Direct RE_Direct_Foliage
  `;
  function patchFoliage(sh, opts = {}) {
    Object.assign(sh.uniforms, uFol);
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + FOL_VHEAD)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n vFolReg = aReg; vFolUv = uv; vFolLeaf = aFol.y;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n folWind(transformed);');
    fs = fs.replace('#include <common>', '#include <common>\n' + FOL_FHEAD + (opts.depth ? '' : FOL_NRM))
      .replace('#include <map_fragment>', opts.depth ? 'vec4 folTex = folSample(); diffuseColor *= folTex;' :
        'vec4 folTex = folSample();\n vec3 folGN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));\n folTex.a *= mix(1.0, smoothstep(0.16, 0.42, abs(dot(folGN, normalize(vViewPosition)))), vFolLeaf);\n diffuseColor *= folTex;');
    if (!opts.depth) {
      fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0') + '\n normal = folPerturb(normal);')
        .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + FOL_TRANSLUCENT)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(0.86, 0.62, vFolLeaf);')
        // a thin leaf takes sky light through its back face as well: shaded foliage was near black
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.indirectDiffuse *= 1.0 + 0.6 * vFolLeaf;')
        // scene alpha 0 marks leaves (vFolLeaf) as thin for Post, which spares them most of the screen-space AO that
        // thin cards would otherwise pile on each other; bark stays solid
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n gl_FragColor.a = 1.0 - vFolLeaf;');
    }
    sh.vertexShader = vs; sh.fragmentShader = fs;
  }
  let folMat = null, folDepth = null;
  function foliageMaterial() {
    if (folMat) return folMat;
    uFol.uFolAtlas.value = buildAtlas(); uFol.uFolNrm.value = nrmTex;
    folMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, envMapIntensity: 0.55 });
    folMat.onBeforeCompile = (sh) => patchFoliage(sh);
    folMat.customProgramCacheKey = () => 'flora-fol';
    folDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, alphaTest: 0.5 });
    folDepth.onBeforeCompile = (sh) => patchFoliage(sh, { depth: true });
    folDepth.customProgramCacheKey = () => 'flora-fol-depth';
    return folMat;
  }

  // ==========================================================================================
  // IMPOSTORS: each species' near model rendered (unlit albedo) into a 4x4 atlas of 256² cells at start-up
  // ==========================================================================================
  const IC = 256, IA = 1024;
  let impTex = null; const impRect = [];   // per kind: [u0, v0, du, dv, widthM, heightM, baseOffsetM]
  function bakeImpostors(renderer, geos) {
    const rt = new THREE.WebGLRenderTarget(IA, IA, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const scene = new THREE.Scene();
    // albedo pass: MeshBasic with the same atlas + vertex AO, no wind
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFolAtlas = uFol.uFolAtlas; sh.uniforms.uFolTime = { value: 0 }; sh.uniforms.uFolWind = { value: 0 };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + FOL_VHEAD).replace('#include <uv_vertex>', '#include <uv_vertex>\n vFolReg = aReg; vFolUv = uv; vFolLeaf = aFol.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FOL_FHEAD).replace('#include <map_fragment>', 'vec4 folTex = folSample(); diffuseColor *= folTex;');
    };
    mat.customProgramCacheKey = () => 'flora-imp-bake';
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x3d4a2f, 0); renderer.clear(true, true, true);
    KINDS.forEach((k, i) => {
      const g = geos[k]; g.computeBoundingBox(); const bb = g.boundingBox;
      const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 1.02, h = (bb.max.y - bb.min.y) * 1.02; const s = Math.max(w, h);
      const mesh = new THREE.Mesh(g, mat); scene.add(mesh);
      const cx = (i % 4) * IC, cy = Math.floor(i / 4) * IC;
      cam.left = -s / 2; cam.right = s / 2; cam.bottom = bb.min.y - (s - h) * 0 - 0.01; cam.top = cam.bottom + s;
      cam.position.set(0, 0, 200); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
      rt.viewport.set(cx, cy, IC, IC); rt.scissor.set(cx, cy, IC, IC); rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      scene.remove(mesh);
      // three's RT viewport origin is bottom-left: cell (cx, cy) in pixels from the bottom
      impRect[i] = [cx / IA, cy / IA, IC / IA, IC / IA, s, s, bb.min.y];
    });
    rt.scissorTest = false;
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevClear, prevAlpha); renderer.autoClear = prevAuto;
    impTex = rt.texture; impTex.anisotropy = 4;
    return impTex;
  }
  // far billboards: InstancedBufferGeometry quad; per instance: offset (xyz, local to anchor), size (w, h), kind, tint
  let farMesh = null, farGeo = null, farMax = 0;
  const uImp = { uImpTex: { value: null }, uImpRects: { value: [] }, uFolTime: U.uTime, uRing: { value: new THREE.Vector4(0, 0, 0, 0) }, uFar: { value: 1650 }, uMidF: { value: [] }, uImpBase: { value: [] } };
  function farMaterial() {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide, envMapIntensity: 0.4 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uImp);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute vec4 aOff; attribute vec4 aImp;   // aOff: xyz + yaw seed; aImp: width, height, kind, tint
        uniform vec4 uImpRects[${NK}]; uniform float uFolTime; uniform vec4 uRing; uniform float uFar; uniform float uMidF[${NK}]; uniform float uImpBase[${NK}];
        varying vec2 vImpUv; varying vec4 vImpRect; varying float vImpTint;`)
        .replace('#include <beginnormal_vertex>', `
          // cylindrical billboard: quad corner (position.x in -0.5..0.5, position.y in 0..1) faces the camera around world up
          vec3 camL = cameraPosition - modelMatrix[3].xyz;
          vec3 toCam = camL - aOff.xyz; toCam.y = 0.0; toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
          vec3 rightV = normalize(vec3(toCam.z, 0.0, -toCam.x));
          vec3 objectNormal = normalize(toCam * 0.55 + rightV * position.x * 1.1 + vec3(0.0, 0.35 + 0.45 * position.y, 0.0));`)
        .replace('#include <begin_vertex>', `
          int ki = int(aImp.z + 0.5);
          vec4 rc = uImpRects[ki];
          float sway = sin(uFolTime * 0.7 + aOff.w * 6.28) * 0.012 * position.y;
          vec3 transformed = aOff.xyz + rightV * (position.x * aImp.x + sway * aImp.y) + vec3(0.0, (position.y + uImpBase[ki]) * aImp.y, 0.0);
          // hidden inside the near/mid rings (same 3D test and camera point as the CPU ring builder), beyond the far
          // radius, and for blanked entries (tiles that streamed out)
          vec3 rd = vec3(aOff.x - uRing.x, aOff.y - uRing.w, aOff.z - uRing.y); float mf = uMidF[ki];
          vec3 cd = aOff.xyz - camL;
          if (aImp.x <= 0.0 || dot(rd, rd) < uRing.z * mf * mf || dot(cd, cd) > uFar * uFar) transformed = vec3(0.0, -1e5, 0.0);
          vImpUv = vec2(position.x + 0.5, position.y); vImpRect = rc; vImpTint = aImp.w;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D uImpTex; varying vec2 vImpUv; varying vec4 vImpRect; varying float vImpTint;`)
        .replace('#include <map_fragment>', `
          vec4 it = texture2D(uImpTex, vImpRect.xy + vImpUv * vImpRect.zw);
          float lod = max(0.0, 0.5 * log2(max(dot(dFdx(vImpUv * ${IC}.0), dFdx(vImpUv * ${IC}.0)), dot(dFdy(vImpUv * ${IC}.0), dFdy(vImpUv * ${IC}.0)))));
          it.a *= 1.0 + lod * 0.3;
          vec3 tint = mix(vec3(0.86, 0.9, 0.84), vec3(1.12, 1.08, 1.0), vImpTint);
          diffuseColor *= vec4(it.rgb * tint, it.a);`)
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n gl_FragColor.a = 0.0;');   // thin (see patchFoliage)
    };
    m.customProgramCacheKey = () => 'flora-far';
    uImp.uMidF.value = Array.from(MIDF);
    return m;
  }
  function makeFar(max) {
    farMax = max;
    farGeo = new THREE.InstancedBufferGeometry();
    farGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    farGeo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    farGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    farGeo.setIndex([0, 1, 2, 0, 2, 3]);
    farGeo.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));
    farGeo.setAttribute('aImp', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));
    farGeo.instanceCount = 0;
    farMesh = new THREE.Mesh(farGeo, farMaterial()); farMesh.frustumCulled = false; farMesh.name = 'flora-far'; farMesh.castShadow = false; farMesh.receiveShadow = false;
    return farMesh;
  }


  // ==========================================================================================
  // SHADOW PROXIES: the shadow pass draws cheap opaque crowns (a few blobs + trunk per species, dappled by a
  // world-space noise) instead of thousands of alpha-tested leaf cards. In the main pass their vertex shader
  // collapses every vertex outside the clip volume (no fragments); the shadow pass uses the real depth material.
  // They share the near ring's instance buffer, so there are no extra uploads.
  // ==========================================================================================
  function proxyGeometry(kind) {
    const p = SPECIES[kind]; const parts = [];
    const add = (g, flex) => { g = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      const n = g.attributes.position.count, f = new Float32Array(n * 2); for (let i = 0; i < n; i++) { f[i * 2] = flex(g.attributes.position.getY(i)); f[i * 2 + 1] = 1; } g.setAttribute('aFol', new THREE.BufferAttribute(f, 2)); parts.push(g); };
    const H = DIM[kind][0]; const fx = (y) => clamp(y / H, 0, 1) ** 2;
    const blob = (r, x, y, z, sx, sy, sz) => { const g = new THREE.IcosahedronGeometry(r, 1); g.scale(sx, sy, sz); g.translate(x, y, z); add(g, fx); };
    const trunk = (r0, r1, h, x = 0, z = 0) => { const g = new THREE.CylinderGeometry(r1, r0, h, 6, 1, true); g.translate(x, h / 2, z); add(g, fx); };
    if (p) {   // broadleaf: ellipsoid crown as 5 blobs
      const [cx, cy, cz, rx, ry, rz] = p.crown;
      trunk(p.trunkR, p.trunkR * 0.6, p.trunkH + ry * 0.4);
      blob(1, cx, cy, cz, rx * 0.72, ry * 0.8, rz * 0.72);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; blob(1, cx + Math.cos(a) * rx * 0.45, cy - ry * 0.1, cz + Math.sin(a) * rz * 0.45, rx * 0.5, ry * 0.62, rz * 0.5); }
    } else if (kind === 'redwood') { trunk(1.1, 0.1, 33); const c = new THREE.ConeGeometry(4.8, 27, 8, 1, true); c.translate(0, 8 + 13.5, 0); add(c, fx); }
    else if (kind === 'pine') { trunk(0.5, 0.15, 18); blob(1, 0, 14.5, 0, 5.4, 4.4, 5.4); }
    else if (kind === 'cypress') { trunk(0.6, 0.34, 8); blob(1, 1.5, 10.5, 0, 6.4, 2.9, 5.2); blob(1, -1.5, 8.8, 0.5, 4, 2.2, 3.6); }
    else if (kind === 'palm') { trunk(0.58, 0.52, 11); blob(1, 0, 12.3, 0, 4.6, 2.0, 4.6); }
    else if (kind === 'fanpalm') { trunk(0.33, 0.22, 20.5); blob(1, 0.5, 21.4, 0, 2.2, 1.9, 2.2); }
    const g = U.mergeGeometries(parts); g.computeBoundingSphere(); return g;
  }
  let proxyDepth = null;
  function proxyDepthMaterial() {
    if (proxyDepth) return proxyDepth;
    proxyDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    proxyDepth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uFolTime: U.uTime, uFolWind: U.uWind });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
          attribute vec2 aFol; uniform float uFolTime; uniform float uFolWind; varying vec3 vPW;
          void folWindP(inout vec3 p) {
            vec3 ip = instanceMatrix[3].xyz; mat3 im = mat3(instanceMatrix);
            float ph = ip.x * 0.061 + ip.z * 0.047; float t = uFolTime;
            float sway = sin(t * 0.72 + ph) * 0.6 + sin(t * 1.63 + ph * 1.7) * 0.3 + sin(t * 3.1 + ph * 2.9) * 0.1;
            vec3 dirL = transpose(im) * normalize(vec3(0.88, 0.0, 0.47)); dirL /= max(1e-4, dot(dirL, dirL));
            p += dirL * sway * (0.04 + 0.32 * uFolWind) * aFol.x * (0.5 + 0.05 * p.y);
          }`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n folWindP(transformed);')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vPW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          varying vec3 vPW;
          float pvn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            float n = dot(i, vec3(1.0, 57.0, 113.0));
            vec4 a = fract(sin(vec4(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453);
            vec4 b = fract(sin(vec4(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
            vec4 m = mix(a, b, f.z); vec2 m2 = mix(m.xy, m.zw, f.y); return mix(m2.x, m2.y, f.x); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          if (pvn(vPW * 1.35) * 0.65 + pvn(vPW * 3.1) * 0.35 > 0.66) discard;   // dappled light through the crown`);
    };
    proxyDepth.customProgramCacheKey = () => 'flora-proxy-depth';
    return proxyDepth;
  }
  const proxyMesh = [];
  function makeProxy(i, kind, near) {
    const nullMat = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }', fragmentShader: 'void main() { discard; }',
      depthWrite: false, depthTest: false, colorWrite: false });
    const m = new THREE.InstancedMesh(proxyGeometry(kind), nullMat, 1);
    m.instanceMatrix = near.instanceMatrix;           // share the near ring's instances
    m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = false; m.customDepthMaterial = proxyDepthMaterial();
    m.name = 'flora-shadow-' + kind; m.visible = false; m.renderOrder = 10;
    proxyMesh[i] = m; return m;
  }

  // ==========================================================================================
  // RUNTIME: streaming tree tiles, grounding, three rings of instances
  // ==========================================================================================
  const group = new THREE.Group(); group.name = 'flora';
  const stats = { tiles: 0, loading: 0, trees: 0, near: 0, mid: 0, far: 0, rebuildMs: 0, loadMs: 0, calls: 0 };
  let ready = false, initP = null, renderer = null, suffix = '';
  const nearMesh = [], midMesh = [], geoNear = {}, geoMid = {};
  const anchor = new V3(); let anchored = false;
  const tiles = new Map();           // 'tx_ty' -> { tx, ty, state, n, D (Float32Array n*10), K (Uint8Array), prio, dead }
  let index = null;                  // Set of 'tx_ty' with tree data (null = unknown: probe by fetching)
  let dirty = true; const lastNear = new V3(1e9, 0, 0);
  // tiles/t2 (same layout; measured canopy heights + crowns the photo detector missed) wherever its index lists the tile
  let t2 = null;
  const DATA_TILE = (tx, ty) => `tiles/${t2 && t2.has(tkey(tx, ty)) ? 't2' : 't'}/7/${tx}_${ty}${suffix}.bin`;
  const tkey = (tx, ty) => tx + '_' + ty;
  const tileOf = (x, z) => [Math.floor((x - X0) / T7), Math.floor((z - Z0) / T7)];
  const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  function makeInstanced(geo, max, shadows) {
    const m = new THREE.InstancedMesh(geo, folMat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    m.count = 0; m.frustumCulled = false; m.castShadow = !!shadows; m.receiveShadow = true; m.customDepthMaterial = folDepth; m.visible = false;
    return m;
  }
  function init(ctx = {}) {
    if (initP) return initP;
    initP = (async () => {
      const t0 = performance.now();
      renderer = ctx.renderer || (typeof Env !== 'undefined' ? Env.renderer : null);
      suffix = ctx.suffix || (typeof window !== 'undefined' && window.BAYLINE_FLORA_SUFFIX) || '';   // dev hook for test tiles
      if (ctx.quality && Q[ctx.quality]) { q = Q[ctx.quality]; qName = ctx.quality; }
      foliageMaterial();
      const geos = {};
      KINDS.forEach((k, i) => {
        geoNear[k] = BUILD[k](0, 101 + i * 17).geometry();
        geoMid[k] = BUILD[k](1, 101 + i * 17).geometry();
        geos[k] = geoNear[k];
        nearMesh[i] = makeInstanced(geoNear[k], q.nearMax, false); nearMesh[i].name = 'flora-near-' + k; nearMesh[i].renderOrder = -2;
        midMesh[i] = makeInstanced(geoMid[k], q.midMax, false); midMesh[i].name = 'flora-mid-' + k; midMesh[i].receiveShadow = false; midMesh[i].renderOrder = -1;
        group.add(nearMesh[i], midMesh[i], makeProxy(i, k, nearMesh[i]));
      });
      if (renderer) { uImp.uImpTex.value = bakeImpostors(renderer, geos); uImp.uImpRects.value = impRect.map(r => new THREE.Vector4(r[0], r[1], r[2], r[3])); uImp.uImpBase.value = impRect.map(r => r[6] / r[5]); }
      group.add(makeFar(q.farMax));
      const scene = ctx.scene || (typeof Env !== 'undefined' ? Env.scene : null);
      if (scene && ctx.addToScene !== false) scene.add(group);
      stats.initMs = Math.round(performance.now() - t0);
      // which L7 tiles have trees: tiles/index.json (products.trees, else level 7 coverage)
      try {
        const idx = ctx.index || (typeof Stream !== 'undefined' ? await Stream.json('tiles/index.json', 1) : null);
        let list = null;
        const tp = idx && idx.products && (idx.products.t || idx.products.trees);
        if (tp && (Array.isArray(tp) || Array.isArray(tp.tiles))) list = Array.isArray(tp) ? tp : tp.tiles;
        const hasTrees = !!tp || (idx && Array.isArray(idx.present) && idx.present.includes('t'));
        if (!list && (hasTrees || ctx.index) && idx.levels && idx.levels['7']) list = idx.levels['7'];   // an explicit ctx.index is taken as given
        if (list) index = new Set(list.map(([x, y]) => tkey(x, y)));
      } catch (e) { index = null; }
      if (typeof Stream !== 'undefined' && !suffix && new URLSearchParams(location.hash.slice(1)).get('t2') !== '0') {
        try { const i2 = await Stream.json('tiles/t2/index.json', 1); t2 = new Set((i2.tiles || []).map(([x, y]) => tkey(x, y))); if (index) for (const k of t2) index.add(k); } catch (e) { t2 = null; }   // (t2 also plants the hills beyond the imagery tiles)
      }
      ready = true; dirty = true;
    })();
    return initP;
  }
  function hasData(x, z) {
    const [tx, ty] = tileOf(x, z); const k = tkey(tx, ty); const t = tiles.get(k);
    if (index) return index.has(k) && !(t && t.state === 'missing');
    return !!(t && t.state === 'ready' && t.n > 0);
  }

  // ---- tile loading: fetch, parse, ground on the terrain, drop trees on the track bed / platforms
  const NF = 10;   // per tree: x, y, z, cos*sx, sin*sx, sy, r, g, b, seed
  // yield to the renderer between parse slices so a 2000-tree tile never costs a long frame
  const yieldTask = () => new Promise(r => setTimeout(r, 0));
  // 20 m cells of the tile within ~60 m of the railway: only trees there pay for the precise bed / platform test
  function trackMaskFor(x0, z0) {
    if (typeof Track === 'undefined' || !Track.X || !Track.n) return null;
    const TX = Track.X, TZ = Track.Z, N = Track.n, G = 20, NG = T7 / G, M = new Uint8Array(NG * NG); let any = false;
    for (let i = 0; i < N; i += 2) {
      const lx = TX[i] - x0, lz = TZ[i] - z0; if (lx < -70 || lz < -70 || lx > T7 + 70 || lz > T7 + 70) continue;
      const ci = Math.floor(lx / G), cj = Math.floor(lz / G);
      for (let dj = -3; dj <= 3; dj++) { const b = cj + dj; if (b < 0 || b >= NG) continue; for (let di = -3; di <= 3; di++) { const a = ci + di; if (a >= 0 && a < NG) { M[b * NG + a] = 1; any = true; } } }
    }
    return any ? M : null;
  }
  const SHRUB = KINDS.indexOf('shrub'), _rf = {};
  function rowShrubs(x0, z0, H) {
    if (typeof Track === 'undefined' || !Track.X || !Track.frame || !Track.offsets) return null;
    const TX = Track.X, TZ = Track.Z, N = Track.n, step = Track.step || 5, out = [];
    const xing = (Track.feat && Track.feat.crossings) || [];
    const mAt = typeof Terrain !== 'undefined' && Terrain.maskAt ? Terrain.maskAt : null;
    const [Hm, Rm] = DIM.shrub;
    for (let i = 0; i < N; i += 2) {                                            // a slot every 10 m of line
      const lx = TX[i] - x0, lz = TZ[i] - z0; if (lx < -20 || lz < -20 || lx > T7 + 20 || lz > T7 + 20) continue;
      const s = i * step;
      if (Track.inTunnel(s) || Track.onBridge(s) || Track.stationNear(s, 160)) continue;
      let nearX = false; for (const c of xing) if (Math.abs(c.s - s) < 30) { nearX = true; break; } if (nearX) continue;
      Track.frame(s, _rf); const offs = Track.offsets(s); let lo = -2.3, hi = 2.3; if (offs.length) { lo = Math.min(...offs); hi = Math.max(...offs); }
      for (const side of [-1, 1]) {
        const hs = hash(i * 3 + (side > 0 ? 1 : 0), 7717); if (hs < 0.38) continue;          // gaps in the hedge
        const cnt = 1 + Math.floor(hash(i + 911, side * 31 + 5) * 2.6);
        for (let k = 0; k < cnt; k++) {
          const along = (hash(i * 7 + k, side * 13 + 11) - 0.5) * 9.5, out1 = 0.7 + hash(i * 5 + k, side * 17 + 3) * 2.4;
          const lat = side < 0 ? lo - 7.6 - out1 : hi + 7.6 + out1;
          const x = _rf.x + _rf.dx * along + _rf.rx * lat, z = _rf.z + _rf.dz * along + _rf.rz * lat;
          if (x < x0 || z < z0 || x >= x0 + T7 || z >= z0 + T7) continue;          // each tile adds only its own
          if (mAt) { if (mAt(x, z, 0) > 0.5) continue; const cls = Math.round(mAt(x, z, 3) * 255); if (cls === 6) continue; }
          const hh = hash(Math.round(x * 7), Math.round(z * 7));
          const sy = lerp(0.65, 1.3, hh), sx = lerp(0.7, 1.25, hash(Math.round(z * 5), Math.round(x * 3)));
          const yaw = hh * TAU, br = lerp(0.8, 1.05, hash(Math.round(x * 3), 21)), hue = (hash(Math.round(z * 3), 23) - 0.5) * 0.1;
          out.push([x, H(x, z) - 0.1 * sy, z, Math.cos(yaw) * sx, Math.sin(yaw) * sx, sy, br * (1 + hue), br, br * (1 - hue), hh]);
          void Hm; void Rm;
        }
      }
    }
    return out;
  }
  async function loadTile(t) {
    t.state = 'loading'; stats.loading++;
    const t0 = performance.now();
    try {
      let u8 = t._bytes || await (typeof Stream !== 'undefined' ? Stream.bin(DATA_TILE(t.tx, t.ty), t.prio) : fetchFallback(DATA_TILE(t.tx, t.ty)));
      if (t.dead) return;
      if (u8.length > 2 && u8[0] === 0x78 && ((u8[0] << 8) | u8[1]) % 31 === 0 && u8.length < 4 + new DataView(u8.buffer, u8.byteOffset).getUint32(0, true) * 8) u8 = await inflateBytes(u8);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const n = dv.getUint32(0, true);
      if (4 + n * 8 > u8.byteLength) throw new Error('bad tree tile ' + t.tx + '_' + t.ty);
      const x0 = X0 + t.tx * T7, z0 = Z0 + t.ty * T7;
      if (typeof Terrain !== 'undefined' && Terrain.ensure) { try { await Terrain.ensure(x0, z0, x0 + T7, z0 + T7, t.prio); } catch (e) { /* ground with what we have */ } }
      if (t.dead) return;
      const mask = trackMaskFor(x0, z0), NG = T7 / 20;
      const hasBed = typeof TrackGeo !== 'undefined' && TrackGeo.bedSpan, hasPlat = typeof Stations !== 'undefined' && Stations.platformY;
      const D = new Float32Array(n * NF), K = new Uint8Array(n); let m = 0, ysum = 0;
      const H = typeof Terrain !== 'undefined' && Terrain.h ? Terrain.h : () => 0;
      let slice = performance.now();
      for (let i = 0; i < n; i++) {
        if ((i & 255) === 255 && performance.now() - slice > 2.5) { await yieldTask(); if (t.dead) return; slice = performance.now(); }
        const o = 4 + i * 8;
        const ux = dv.getUint16(o, true), uz = dv.getUint16(o + 2, true);
        const x = x0 + ux / 65536 * T7, z = z0 + uz / 65536 * T7;
        const rB = u8[o + 4], hB = u8[o + 5]; let kind = u8[o + 6]; const tint = u8[o + 7] / 255;
        if (kind >= NK) kind = 7;
        if (mask && mask[Math.min(NG - 1, (uz * NG) >> 16) * NG + Math.min(NG - 1, (ux * NG) >> 16)]) {
          const tr = Track.nearest(x, z, 50);
          if (tr) {
            let lo = -4, hi = 4; if (hasBed) { const bs = TrackGeo.bedSpan(tr.s); lo = bs[0]; hi = bs[1]; }
            if (tr.lat > lo - 1.8 && tr.lat < hi + 1.8) continue;                                        // on the track bed
            if (hasPlat && Math.abs(tr.lat) < 48 && Stations.platformY(x, z) !== null) continue;          // on a platform
          }
        }
        const [Hm, Rm] = DIM[KINDS[kind]]; const hh = hash(Math.round(x * 7), Math.round(z * 7));
        let hgt = hB * 0.25, rad = rB * 0.1;
        if (!(hgt > 1)) hgt = Hm * lerp(0.75, 1.1, hh);
        if (!(rad > 0.4)) rad = Rm * lerp(0.75, 1.1, hh);
        let sy = hgt / Hm, sx = rad / Rm;
        const pal = kind === 3 || kind === 8;
        if (!pal) { if (sy / sx > 1.45) sx = sy / 1.45; if (sy / sx < 0.62) sy = sx * 0.62; } else sx = Math.max(sx, sy * 0.7);
        sx = clamp(sx, 0.3, 2.4); sy = clamp(sy, 0.3, 2.4);
        const yaw = hh * TAU, c = Math.cos(yaw), sn = Math.sin(yaw);
        const y = H(x, z) - 0.15 * sy;
        const br = lerp(0.84, 1.12, tint) * lerp(0.94, 1.06, hash(Math.round(z * 3), 5)); const hue = (hash(Math.round(x * 3), 9) - 0.5) * 0.12;
        const b = m * NF;
        D[b] = x; D[b + 1] = y; D[b + 2] = z; D[b + 3] = c * sx; D[b + 4] = sn * sx; D[b + 5] = sy;
        D[b + 6] = br * (1 + hue); D[b + 7] = br; D[b + 8] = br * (1 - hue * 1.2); D[b + 9] = hh;
        K[m] = kind; m++; ysum += y;
      }
      if (t.dead) return;
      // hedges and shrubs along the right of way (oleander, pittosporum, ivy on the fences) are too small for the crown
      // detection, so they are generated: just outside the fence line on both sides, with irregular gaps, never at
      // stations, crossings, tunnels, bridges, on water or on paved ground
      const extra = mask ? rowShrubs(x0, z0, H) : null;
      let DD = D, KK = K;
      if (extra && extra.length) {
        DD = new Float32Array((m + extra.length) * NF); DD.set(D.subarray(0, m * NF)); KK = new Uint8Array(m + extra.length); KK.set(K.subarray(0, m));
        for (const e of extra) { DD.set(e, m * NF); KK[m] = SHRUB; ysum += e[1]; m++; }
        stats.shrubs = (stats.shrubs || 0) + extra.length;
      }
      t.D = DD; t.K = KK; t.n = m; t.ym = m ? ysum / m : 0; t.state = 'ready'; dirty = true; stats.trees += m;
      if (m) pendingFar.push(t);
    } catch (e) {
      if (!t.dead) { t.state = e && e.notFound ? 'missing' : 'empty'; t.n = 0; }
    } finally { stats.loading--; stats.loadMs = Math.round(performance.now() - t0); }
  }
  async function inflateBytes(u8) { const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function fetchFallback(path) {
    const base = (typeof window !== 'undefined' && window.BAYLINE_DATA) || './data/v2/';
    const r = await fetch(base + path); if (!r.ok) throw new Error(r.status + ' ' + path);
    const ct = r.headers.get('content-type') || ''; if (ct.startsWith('text/html')) throw new Error('html');
    const u8 = new Uint8Array(await r.arrayBuffer());
    return (u8[0] === 0x78) ? inflateBytes(u8) : u8;
  }

  // ---- rings
  const nk = new Int32Array(NK), mk = new Int32Array(NK);
  // mid-ring reach per species (fraction of q.mid): small / bushy crowns hand over to impostors sooner, tall ones later
  const MIDF = new Float32Array([0.62, 1.0, 1.0, 0.8, 0.8, 0.8, 0.8, 0.5, 1.0]);
  function writeInst(mesh, slot, D, b) {
    const a = mesh.instanceMatrix.array, o = slot * 16;
    const cs = D[b + 3], sn = D[b + 4], sy = D[b + 5];
    a[o] = cs; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = cs; a[o + 11] = 0;
    a[o + 12] = D[b] - anchor.x; a[o + 13] = D[b + 1] - anchor.y; a[o + 14] = D[b + 2] - anchor.z; a[o + 15] = 1;
    const c = mesh.instanceColor.array, oc = slot * 3; c[oc] = D[b + 6]; c[oc + 1] = D[b + 7]; c[oc + 2] = D[b + 8];
  }
  // near + mid rings: CPU-selected around the camera (3D distance, so the rings shrink as the camera climbs and the
  // impostors / ground photo take over), rebuilt every ~12 m of camera movement; only tiles within the mid reach are scanned
  function rebuild(cam) {
    const t0 = performance.now(); sortCam.copy(cam); ringCam.copy(cam);
    if (!anchored || Math.abs(cam.x - anchor.x) > 3000 || Math.abs(cam.z - anchor.z) > 3000) {
      anchor.set(Math.round(cam.x), 0, Math.round(cam.z)); group.position.copy(anchor); anchored = true; farFull = true;
    }
    const rn2 = q.near * q.near, rm2 = q.mid * q.mid;
    nk.fill(0); mk.fill(0);
    for (const t of tiles.values()) {
      if (t.state !== 'ready' || !t.n) continue;
      const x0 = X0 + t.tx * T7, z0 = Z0 + t.ty * T7;
      const dx0 = Math.max(x0 - cam.x, 0, cam.x - x0 - T7), dz0 = Math.max(z0 - cam.z, 0, cam.z - z0 - T7), dy0 = Math.max(0, Math.abs(cam.y - t.ym) - 90);
      if (dx0 * dx0 + dz0 * dz0 + dy0 * dy0 > rm2) continue;
      const D = t.D, K = t.K;
      for (let i = 0; i < t.n; i++) {
        const b = i * NF; const dx = D[b] - cam.x, dy = D[b + 1] - cam.y, dz = D[b + 2] - cam.z; const d2 = dx * dx + dy * dy + dz * dz;
        const k = K[i];
        if (d2 < rn2) { if (nk[k] < q.nearMax) writeInst(nearMesh[k], nk[k]++, D, b); else if (mk[k] < q.midMax) writeInst(midMesh[k], mk[k]++, D, b); }
        else if (d2 < rm2 * MIDF[k] * MIDF[k]) { if (mk[k] < q.midMax) writeInst(midMesh[k], mk[k]++, D, b); }
      }
    }
    for (let k = 0; k < NK; k++) if (nk[k] > 1) sortRing(nearMesh[k], nk[k]);
    let near = 0, mid = 0;
    for (let k = 0; k < NK; k++) {
      for (const [mesh, cnt] of [[nearMesh[k], nk[k]], [midMesh[k], mk[k]]]) {
        mesh.count = cnt; mesh.visible = cnt > 0;
        if (cnt) { mesh.instanceMatrix.updateRange.offset = 0; mesh.instanceMatrix.updateRange.count = cnt * 16; mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.updateRange.offset = 0; mesh.instanceColor.updateRange.count = cnt * 3; mesh.instanceColor.needsUpdate = true; }
      }
      const pm = proxyMesh[k]; pm.count = q.shadows ? nk[k] : 0; pm.visible = pm.count > 0;
      near += nk[k]; mid += mk[k];
    }
    // the impostor shader hides trees the rings already draw, measured from the same camera point (anchor.y is 0)
    uImp.uRing.value.set(ringCam.x - anchor.x, ringCam.z - anchor.z, rm2, ringCam.y); uImp.uFar.value = q.far;
    stats.near = near; stats.mid = mid; stats.rebuildMs = +(performance.now() - t0).toFixed(2);
  }
  // far ring: one impostor per loaded tree. Arriving tiles are appended (cheap), departing tiles are blanked in place
  // (zero size), and the buffer is compacted with a full rewrite only when the anchor moves or a third of it is dead.
  // The vertex shader hides trees inside the rings and beyond the far radius.
  const ringCam = new V3(); let farFull = true;
  const farSeg = new Map(), pendingFar = []; let farUsed = 0, farDeadN = 0, farLo = Infinity, farHi = -1;
  function appendFar(t, compacting) {
    const key = tkey(t.tx, t.ty); if (t.dead || farSeg.has(key) || t.state !== 'ready' || !t.n) return;
    const n = t.n;
    if (farUsed + n > farMax) {                    // no room: compact if that would help, else leave this (far) tile out
      if (!compacting && farDeadN > 0) farFull = true; else stats.farDropped = (stats.farDropped || 0) + n;
      return;
    }
    const off = farGeo.attributes.aOff.array, imp = farGeo.attributes.aImp.array, D = t.D, K = t.K; let j = farUsed;
    for (let i = 0; i < n; i++, j++) {
      const b = i * NF, k = K[i]; const ir = impRect[k]; const o4 = j * 4;
      if (!ir) { imp[o4] = 0; imp[o4 + 1] = 0; continue; }
      off[o4] = D[b] - anchor.x; off[o4 + 1] = D[b + 1] - anchor.y; off[o4 + 2] = D[b + 2] - anchor.z; off[o4 + 3] = D[b + 9];
      imp[o4] = ir[4] * Math.hypot(D[b + 3], D[b + 4]); imp[o4 + 1] = ir[5] * D[b + 5]; imp[o4 + 2] = k; imp[o4 + 3] = clamp((D[b + 7] - 0.84) / 0.28, 0, 1);
    }
    farSeg.set(key, { start: farUsed, n }); farLo = Math.min(farLo, farUsed); farHi = Math.max(farHi, farUsed + n); farUsed += n;
  }
  function killFar(key) {
    const sg = farSeg.get(key); if (!sg) return; const imp = farGeo.attributes.aImp.array;
    for (let j = sg.start; j < sg.start + sg.n; j++) { imp[j * 4] = 0; imp[j * 4 + 1] = 0; }
    farSeg.delete(key); farDeadN += sg.n; farLo = Math.min(farLo, sg.start); farHi = Math.max(farHi, sg.start + sg.n);
  }
  function rebuildFar() {
    const t0 = performance.now();
    farSeg.clear(); farUsed = 0; farDeadN = 0; farFull = false; pendingFar.length = 0; stats.farDropped = 0;
    const list = [...tiles.values()].filter(t => t.state === 'ready' && t.n);    // nearest tiles first, in case the buffer overflows
    const cx = ringCam.x, cz = ringCam.z; const dist = t => Math.hypot(X0 + (t.tx + 0.5) * T7 - cx, Z0 + (t.ty + 0.5) * T7 - cz);
    list.sort((a, b) => dist(a) - dist(b));
    for (const t of list) appendFar(t, true);
    farLo = 0; farHi = Math.max(farUsed, 1);
    farGeo.instanceCount = farUsed; farMesh.visible = farUsed > 0; stats.far = farUsed;
    stats.farMs = +(performance.now() - t0).toFixed(2);
  }
  function flushFar() {
    if (farHi <= farLo) return;
    farGeo.instanceCount = farUsed; farMesh.visible = farUsed > 0;
    for (const n of ['aOff', 'aImp']) { const at = farGeo.attributes[n]; at.updateRange.offset = farLo * 4; at.updateRange.count = (Math.min(farHi, farMax) - farLo) * 4; at.needsUpdate = true; }
    farLo = Infinity; farHi = -1; stats.far = farUsed - farDeadN;
  }

  // sort a ring's instances nearest-first (instance order = draw order) so near leaves hide far ones early
  const sortCam = new V3(); let sIdx = new Int32Array(0), sKey = new Float32Array(0), sM = new Float32Array(0), sC = new Float32Array(0);
  function sortRing(mesh, n) {
    if (sIdx.length < n) { sIdx = new Int32Array(n * 2); sKey = new Float32Array(n * 2); sM = new Float32Array(n * 32); sC = new Float32Array(n * 6); }
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    const ax = sortCam.x - anchor.x, az = sortCam.z - anchor.z;
    for (let i = 0; i < n; i++) { const dx = M[i * 16 + 12] - ax, dz = M[i * 16 + 14] - az; sKey[i] = dx * dx + dz * dz; sIdx[i] = i; }
    const idx = Array.prototype.slice.call(sIdx, 0, n).sort((a, b) => sKey[a] - sKey[b]);
    sM.set(M.subarray(0, n * 16)); sC.set(C.subarray(0, n * 3));
    for (let j = 0; j < n; j++) { const i = idx[j]; M.set(sM.subarray(i * 16, i * 16 + 16), j * 16); C[j * 3] = sC[i * 3]; C[j * 3 + 1] = sC[i * 3 + 1]; C[j * 3 + 2] = sC[i * 3 + 2]; }
  }

  // ---- per frame
  let lastTileCheck = -1e9;
  function update(camPos, env) {
    if (!ready || !camPos) return;
    const now = performance.now();
    if (now - lastTileCheck > 250 || dirty) {
      lastTileCheck = now;
      const ground = typeof Terrain !== 'undefined' && Terrain.h ? Terrain.h(camPos.x, camPos.z) : 0;
      const alt = Math.max(0, camPos.y - ground);
      const reach = Math.sqrt(Math.max(0, q.load * q.load - alt * alt));        // nothing to load when flying above the far ring
      const [ctx, cty] = tileOf(camPos.x, camPos.z); const R = Math.ceil(reach / T7) + 1;
      if (reach > 0) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const tx = ctx + dx, ty = cty + dy; const k = tkey(tx, ty);
        const cx = X0 + (tx + 0.5) * T7, cz = Z0 + (ty + 0.5) * T7; const d = Math.hypot(cx - camPos.x, cz - camPos.z) - T7 * 0.71;
        if (d > reach) continue;
        if (index && !index.has(k)) continue;
        let t = tiles.get(k);
        if (!t) { t = { tx, ty, state: 'new', n: 0, prio: 2 + Math.max(0, d) / 400, dead: false }; tiles.set(k, t); loadTile(t); }
        else if (t.state === 'loading' && typeof Stream !== 'undefined') Stream.prioritize(DATA_TILE(tx, ty), 2 + Math.max(0, d) / 400);
      }
      for (const [k, t] of tiles) {
        const cx = X0 + (t.tx + 0.5) * T7, cz = Z0 + (t.ty + 0.5) * T7;
        if (Math.hypot(cx - camPos.x, cz - camPos.z) - T7 * 0.71 > q.load + 900) {
          t.dead = true; if (t.state === 'loading' && typeof Stream !== 'undefined') Stream.cancel(DATA_TILE(t.tx, t.ty));
          if (t.state === 'ready') { stats.trees -= t.n; killFar(k); }
          tiles.delete(k); dirty = true;
        }
      }
      stats.tiles = tiles.size;
    }
    if (dirty || lastNear.distanceToSquared(camPos) > 12 * 12) { rebuild(camPos); lastNear.copy(camPos); dirty = false; }
    if (farFull || farDeadN > Math.max(2000, farUsed * 0.35)) rebuildFar();
    else { while (pendingFar.length) appendFar(pendingFar.shift(), false); if (farFull) rebuildFar(); }   // compact once if an append ran out of room
    flushFar();
  }
  function setQuality(name) {
    if (!Q[name] || name === qName) return; const old = q; q = Q[name]; qName = name;
    // capacities are fixed at init (the high tier); lower tiers just use fewer instances
    q = Object.assign({}, q, { nearMax: Math.min(q.nearMax, old.nearMax, nearMesh[0] ? nearMesh[0].instanceMatrix.count : q.nearMax), midMax: Math.min(q.midMax, midMesh[0] ? midMesh[0].instanceMatrix.count : q.midMax), farMax: Math.min(q.farMax, farMax || q.farMax) });
    for (const m of nearMesh) m.castShadow = false;
    dirty = true;
  }
  function dispose() {
    for (const t of tiles.values()) t.dead = true; tiles.clear(); stats.trees = 0;
    for (const m of [...nearMesh, ...midMesh, ...proxyMesh]) { m.count = 0; m.visible = false; }
    if (farGeo) { farGeo.instanceCount = 0; farSeg.clear(); farUsed = 0; farDeadN = 0; pendingFar.length = 0; }
    dirty = true;
  }
  // debug / preview: feed a tile from bytes instead of the network (same record layout as the tiles)
  function addTestTile(tx, ty, bytes) { const t = { tx, ty, state: 'new', n: 0, prio: 1, dead: false, _bytes: bytes }; tiles.set(tkey(tx, ty), t); return loadTile(t); }
  // trees near a point (loaded tiles only): [{ x, z, y0 (ground), top, r (crown radius) }], for line-of-sight tests
  function treesNear(x, z, r, out = []) {
    const [a0, b0] = tileOf(x - r, z - r), [a1, b1] = tileOf(x + r, z + r);
    for (let ty = b0; ty <= b1; ty++) for (let tx = a0; tx <= a1; tx++) {
      const t = tiles.get(tkey(tx, ty)); if (!t || t.state !== 'ready' || !t.n) continue;
      const D = t.D, K = t.K;
      for (let i = 0; i < t.n; i++) { const b = i * NF, dx = D[b] - x, dz = D[b + 2] - z; if (dx * dx + dz * dz > r * r) continue;
        const dim = DIM[KINDS[K[i]]] || [10, 5], sx = Math.hypot(D[b + 3], D[b + 4]);
        out.push({ x: D[b], z: D[b + 2], y0: D[b + 1], top: D[b + 1] + dim[0] * D[b + 5], r: dim[1] * sx }); }
    }
    return out;
  }
  return {
    init, update, hasData, covers: hasData, setQuality, dispose, group, stats, KINDS, DIM, treesNear,
    get ready() { return ready; }, get quality() { return qName; }, get radii() { return { near: q.near, mid: q.mid, far: q.far, load: q.load }; },
    _geo: { near: geoNear, mid: geoMid }, _atlas: () => atlasTex, _nrm: () => nrmTex, _imp: () => impTex, _tiles: tiles, addTestTile,
  };
})();
