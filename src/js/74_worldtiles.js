// WorldTiles: 3D buildings and airport surfaces for the rest of the planet, from OpenFreeMap vector tiles (OpenMapTiles
// schema; "OpenFreeMap © OpenMapTiles Data from OpenStreetMap"). Around the camera (below ~3 km) the z14 tiles are
// decoded in a worker: building footprints extruded to their OSM heights (walls + roofs), aprons as concrete, taxiways
// as asphalt with yellow centre lines. A facade shader draws floors and windows (lit at night). Tiles are placed like
// globe nodes, so a frame rebase only moves them. Skipped inside the Bayline square, which has its own city.
//   WorldTiles.update(camera)    per frame      WorldTiles.enabled
const WorldTiles = (() => {
  const Z = 14, D = Math.PI / 180;
  const group = new THREE.Group(); group.name = 'world-tiles';
  const tiles = new Map(); let worker = null, busy = 0, enabled = true, mat = null, aeroMat = null, url = null, frameNo = 0;
  const stats = { tiles: 0, tris: 0 };
  // ---------------------------------------------------------------- the worker: MVT decoding and meshing
  const WORKER = `
  const rd = (b) => { let p = 0; const len = b.length;
    const varint = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; };
    return { get p() { return p; }, set p(v) { p = v; }, len, varint,
      skip(t) { if (t === 0) varint(); else if (t === 1) p += 8; else if (t === 2) { const l = varint(); p += l; } else if (t === 5) p += 4; },
      bytes() { const l = varint(); const s = b.subarray(p, p + l); p += l; return s; },
      str() { const s = this.bytes(); return new TextDecoder().decode(s); },
      dbl() { const v = new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true); p += 8; return v; },
      flt() { const v = new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, true); p += 4; return v; } }; };
  const zz = (n) => (n >>> 1) ^ -(n & 1);
  function value(b) { const r = rd(b); let v = null; while (r.p < r.len) { const k = r.varint(), f = k >> 3, t = k & 7;
    if (f === 1) v = r.str(); else if (f === 2) v = r.flt(); else if (f === 3) v = r.dbl(); else if (f === 4 || f === 5) v = r.varint(); else if (f === 6) v = zz(r.varint()); else if (f === 7) v = !!r.varint(); else r.skip(t); } return v; }
  function packed(b) { const r = rd(b), out = []; while (r.p < r.len) out.push(r.varint()); return out; }
  function layer(b) { const r = rd(b), L = { name: '', feats: [], keys: [], vals: [], extent: 4096 };
    while (r.p < r.len) { const k = r.varint(), f = k >> 3, t = k & 7;
      if (f === 1) L.name = r.str(); else if (f === 2) L.feats.push(r.bytes()); else if (f === 3) L.keys.push(r.str()); else if (f === 4) L.vals.push(value(r.bytes())); else if (f === 5) L.extent = r.varint(); else r.skip(t); }
    return L; }
  function feature(b, L) { const r = rd(b), F = { type: 0, tags: {}, geom: null };
    while (r.p < r.len) { const k = r.varint(), f = k >> 3, t = k & 7;
      if (f === 2) { const tg = packed(r.bytes()); for (let i = 0; i + 1 < tg.length; i += 2) F.tags[L.keys[tg[i]]] = L.vals[tg[i + 1]]; }
      else if (f === 3) F.type = r.varint(); else if (f === 4) F.geom = packed(r.bytes()); else r.skip(t); }
    return F; }
  function rings(g) {   // command stream -> rings / lines of [x, y]
    const out = []; let x = 0, y = 0, cur = null;
    for (let i = 0; i < g.length;) { const c = g[i++], id = c & 7, n = c >> 3;
      if (id === 1 || id === 2) for (let k = 0; k < n; k++) { x += zz(g[i++]); y += zz(g[i++]); if (id === 1) { cur = []; out.push(cur); } cur.push([x, y]); }
      else if (id === 7 && cur) cur.push(cur[0]); }
    return out; }
  const area = (R) => { let a = 0; for (let i = 0, n = R.length - 1; i < n; i++) a += R[i][0] * R[i + 1][1] - R[i + 1][0] * R[i][1]; return a / 2; };
  function earclip(P) {  // simple polygon (no holes), returns triangles as index triples
    const n = P.length, idx = [...Array(n).keys()], tris = []; if (n < 3) return tris;
    let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += P[i][0] * P[j][1] - P[j][0] * P[i][1]; }
    const ccw = A > 0; let guard = 0;
    while (idx.length > 3 && guard++ < 5000) { let cut = false;
      for (let i = 0; i < idx.length; i++) { const a = P[idx[(i + idx.length - 1) % idx.length]], b = P[idx[i]], c = P[idx[(i + 1) % idx.length]];
        const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); if (ccw ? cr <= 0 : cr >= 0) continue;
        let inside = false; for (let j = 0; j < idx.length && !inside; j++) { const p = P[idx[j]]; if (p === a || p === b || p === c) continue;
          const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]), d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]), d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
          inside = ccw ? (d1 > 0 && d2 > 0 && d3 > 0) : (d1 < 0 && d2 < 0 && d3 < 0); }
        if (inside) continue; tris.push([idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]]); idx.splice(i, 1); cut = true; break; }
      if (!cut) break; }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]); return tris; }
  const PAL = [[0.78, 0.74, 0.68], [0.72, 0.66, 0.58], [0.62, 0.5, 0.42], [0.82, 0.8, 0.76], [0.68, 0.68, 0.7], [0.55, 0.45, 0.38], [0.86, 0.84, 0.8], [0.6, 0.62, 0.66]];
  function hexcol(s) { const m = /^#?([0-9a-f]{6})$/i.exec(s || ''); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; }
  onmessage = async (e) => {
    const { id, url, mx, my, hs } = e.data;   // hs: ground heights (17x17 over the tile) for the base of each building
    try {
      const r = await fetch(url); if (!r.ok) throw new Error('tile ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer()), t = rd(buf); const layers = {};
      while (t.p < t.len) { const k = t.varint(); if ((k >> 3) === 3) { const L = layer(t.bytes()); layers[L.name] = L; } else t.skip(k & 7); }
      const P = [], N = [], C = [], A = [];  // building positions / normals / colours / aux (x: kind 0 wall 1 roof 2 apron 3 taxi, y: height of floor band)
      const ext = (layers.building || layers.aeroway || { extent: 4096 }).extent;
      const toM = (x, y) => [(x / ext - 0.5) * mx, (y / ext - 0.5) * my];   // metres from the tile centre (x east, y south)
      const hAt = (x, y) => { const u = Math.max(0, Math.min(16, x / ext * 16)), v = Math.max(0, Math.min(16, y / ext * 16)), i = Math.min(15, u | 0), j = Math.min(15, v | 0), a = u - i, b = v - j;
        return (hs[j * 17 + i] * (1 - a) + hs[j * 17 + i + 1] * a) * (1 - b) + (hs[(j + 1) * 17 + i] * (1 - a) + hs[(j + 1) * 17 + i + 1] * a) * b; };
      const push = (px, py, pz, nx, ny, nz, c, k, f) => { P.push(px, py, pz); N.push(nx, ny, nz); C.push(c[0], c[1], c[2]); A.push(k, f); };
      let nb = 0;
      if (layers.building) for (const fb of layers.building.feats) {
        const f = feature(fb, layers.building); if (f.type !== 3 || f.tags.hide_3d) continue;
        const rs = rings(f.geom); if (!rs.length) continue;
        const H = Math.max(3, +f.tags.render_height || 8), h0 = +f.tags.render_min_height || 0;
        for (const R of rs) {
          const ar = area(R); if (ar <= 0 || R.length < 4) continue;              // exterior rings (positive area in MVT); holes skipped
          const pts = R.slice(0, -1).map(p => toM(p[0], p[1]));
          let cx = 0, cy = 0; for (const p of R) { cx += p[0]; cy += p[1]; } cx /= R.length; cy /= R.length;
          const base = hAt(cx, cy), y0 = base + h0 - (h0 ? 0 : 1.5), y1 = base + H;
          const hash = Math.abs(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1;
          const col = hexcol(f.tags.colour) || (H > 40 ? [0.66 + hash * 0.1, 0.7 + hash * 0.08, 0.74 + hash * 0.06] : PAL[(hash * PAL.length) | 0]);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = Math.hypot(dx, dz); if (L2 < 0.05) continue;
            const nx = dz / L2, nz = -dx / L2;
            push(a[0], y0, a[1], nx, 0, nz, col, 0, h0); push(b[0], y1, b[1], nx, 0, nz, col, 0, h0); push(b[0], y0, b[1], nx, 0, nz, col, 0, h0);
            push(a[0], y0, a[1], nx, 0, nz, col, 0, h0); push(a[0], y1, a[1], nx, 0, nz, col, 0, h0); push(b[0], y1, b[1], nx, 0, nz, col, 0, h0);
          }
          const rc = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
          for (const [i, j, k] of earclip(pts)) { const a = pts[i], b = pts[j], c = pts[k]; push(a[0], y1, a[1], 0, 1, 0, rc, 1, 0); push(c[0], y1, c[1], 0, 1, 0, rc, 1, 0); push(b[0], y1, b[1], 0, 1, 0, rc, 1, 0); }
          nb++;
        }
      }
      // airport surfaces: aprons (polygons), taxiways (lines as strips), from the aeroway layer
      const Q = [], QN = [], QC = [], QA = [];
      const pushQ = (px, py, pz, c, k, f) => { Q.push(px, py, pz); QN.push(0, 1, 0); QC.push(c[0], c[1], c[2]); QA.push(k, f); };
      if (layers.aeroway) for (const fb of layers.aeroway.feats) {
        const f = feature(fb, layers.aeroway), cls = f.tags.class, rs = rings(f.geom);
        if (f.type === 3 && (cls === 'apron' || cls === 'helipad' || cls === 'taxiway')) for (const R of rs) {
          if (area(R) <= 0 || R.length < 4) continue; const pts = R.slice(0, -1).map(p => toM(p[0], p[1])), hs2 = R.slice(0, -1).map(p => hAt(p[0], p[1]) + 0.12);
          const col = cls === 'apron' ? [0.6, 0.6, 0.58] : [0.33, 0.33, 0.33];
          for (const [i, j, k] of earclip(pts)) { pushQ(pts[i][0], hs2[i], pts[i][1], col, 2, 0); pushQ(pts[k][0], hs2[k], pts[k][1], col, 2, 0); pushQ(pts[j][0], hs2[j], pts[j][1], col, 2, 0); }
        }
        if (f.type === 2 && cls === 'taxiway') for (const R of rs) {
          const pts = R.map(p => toM(p[0], p[1])), hh = R.map(p => hAt(p[0], p[1]) + 0.15), w = 11.5;
          for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = Math.hypot(dx, dz) || 1, ox = -dz / L2 * w, oz = dx / L2 * w;
            const g = [0.3, 0.3, 0.3];
            pushQ(a[0] - ox, hh[i], a[1] - oz, g, 3, -1); pushQ(b[0] + ox, hh[i + 1], b[1] + oz, g, 3, 1); pushQ(b[0] - ox, hh[i + 1], b[1] - oz, g, 3, -1);
            pushQ(a[0] - ox, hh[i], a[1] - oz, g, 3, -1); pushQ(a[0] + ox, hh[i], a[1] + oz, g, 3, 1); pushQ(b[0] + ox, hh[i + 1], b[1] + oz, g, 3, 1); }
        }
      }
      const f32 = (a) => new Float32Array(a);
      const out = { id, b: { p: f32(P), n: f32(N), c: f32(C), a: f32(A) }, q: { p: f32(Q), n: f32(QN), c: f32(QC), a: f32(QA) }, nb };
      postMessage(out, [out.b.p.buffer, out.b.n.buffer, out.b.c.buffer, out.b.a.buffer, out.q.p.buffer, out.q.n.buffer, out.q.c.buffer, out.q.a.buffer]);
    } catch (err) { postMessage({ id, error: String(err) }); }
  };`;
  // ---------------------------------------------------------------- materials
  function materials() {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    m.customProgramCacheKey = () => 'bl-wtile-v1';
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = U.uNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aAux; varying vec2 vAux; varying vec3 vWP; varying vec3 vWN;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvAux = aAux; vWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          uniform float uNight; varying vec2 vAux; varying vec3 vWP; varying vec3 vWN; float gWin;
          float wh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          gWin = 0.0;
          if (vAux.x < 0.5 && abs(vWN.y) < 0.4) {             // walls: floors every 3.3 m, a window every 2.8 m
            vec2 t = normalize(vec2(-vWN.z, vWN.x)); float u = dot(vWP.xz, t), fl = (vWP.y - vAux.y) / 3.3;
            float fw = fwidth(u) + fwidth(fl) * 3.3;
            float fy = fract(fl), fx = fract(u / 2.8), win = smoothstep(0.22, 0.26, fy) * (1.0 - smoothstep(0.74, 0.78, fy)) * smoothstep(0.16, 0.2, fx) * (1.0 - smoothstep(0.8, 0.84, fx));
            win *= 1.0 - smoothstep(0.6, 1.4, fw);                 // average out far away
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.14, 0.17), win * 0.75);
            gWin = win * step(0.62, wh(floor(vec2(u / 2.8, fl)) + floor(vWP.xz / 97.0)));
          } else if (vAux.x > 2.5) {                              // taxiway: yellow centre line
            float cl = 1.0 - smoothstep(0.03, 0.06, abs(vAux.y)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.66, 0.1), cl);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.78, 0.5) * gWin * uNight * 1.4;`);
    };
    return m;
  }
  // ---------------------------------------------------------------- tiles
  const txf = (lon) => (lon + 180) / 360 * 2 ** Z, tyf = (lat) => { const r = lat * D; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z; };
  const lonOf = (x) => x / 2 ** Z * 360 - 180, latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** Z))) / D;
  async function tileUrl() {
    if (url) return url;
    const j = await (await fetch('https://tiles.openfreemap.org/planet')).json(); url = j.tiles[0]; return url;
  }
  function request(x, y) {
    const k = x + '/' + y; if (tiles.has(k)) return;
    const lonW = lonOf(x), lonE = lonOf(x + 1), latN = latOf(y), latS = latOf(y + 1), lat = (latN + latS) / 2, lon = (lonW + lonE) / 2;
    const c = Globe.ll2w(lat, lon); if (Globe.frame.bay && Globe.inBayline(c.x, c.z)) { tiles.set(k, { k, skip: true, used: frameNo }); return; }
    const p = Math.cos(lat * D), mlat = 111132.954 - 559.822 * Math.cos(2 * lat * D), mlon = 111412.84 * p;
    const mx = (lonE - lonW) * mlon, my = (latN - latS) * mlat;
    const t = { k, x, y, lat, lon, mlat, mlon, mx, my, state: 1, used: frameNo, mesh: null, aero: null, fid: -1 };
    tiles.set(k, t);
    // ground heights over the tile for the building bases
    const hs = new Float32Array(17 * 17);
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) hs[j * 17 + i] = Globe.hAt(latOf(y + j / 16), lonOf(x + i / 16));
    busy++;
    tileUrl().then(u => worker.postMessage({ id: k, url: u.replace('{z}', Z).replace('{x}', x).replace('{y}', y), mx, my, hs }));
  }
  function geo(o) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(o.p, 3)); g.setAttribute('normal', new THREE.BufferAttribute(o.n, 3));
    g.setAttribute('color', new THREE.BufferAttribute(o.c, 3)); g.setAttribute('aAux', new THREE.BufferAttribute(o.a, 2)); g.computeBoundingSphere(); return g;
  }
  function received(e) {
    busy--; const d = e.data, t = tiles.get(d.id); if (!t) return;
    if (d.error) { t.state = 3; return; }
    if (!mat) { mat = materials(); aeroMat = materials(); aeroMat.polygonOffset = true; aeroMat.polygonOffsetFactor = -2; aeroMat.polygonOffsetUnits = -4; }
    if (d.b.p.length) { t.mesh = new THREE.Mesh(geo(d.b), mat); t.mesh.castShadow = true; t.mesh.receiveShadow = true; t.mesh.matrixAutoUpdate = false; t.mesh.layers.enable(1); group.add(t.mesh); stats.tris += d.b.p.length / 9; }
    if (d.q.p.length) { t.aero = new THREE.Mesh(geo(d.q), aeroMat); t.aero.receiveShadow = true; t.aero.matrixAutoUpdate = false; t.aero.layers.enable(1); t.aero.renderOrder = -2; group.add(t.aero); }
    t.state = 2; t.mlatB = Globe.frame.mlat; t.mlonB = Globe.frame.mlon; t.fid = -1; place(t); stats.tiles++;
  }
  function place(t) {    // position / stretch in the current frame (like globe nodes)
    if (t.fid === Globe.frame.id) return;
    // vertices are metres at the tile's own latitude; the frame's equirectangular metres per degree scale them
    const c = Globe.ll2w(t.lat, t.lon), sx = Globe.frame.mlon / t.mlon, sz = Globe.frame.mlat / t.mlat;
    for (const m of [t.mesh, t.aero]) if (m) { m.position.set(c.x, 0, c.z); m.scale.set(sx, 1, sz); m.updateMatrix(); }
    t.fid = Globe.frame.id;
  }
  function drop(t) {
    for (const m of [t.mesh, t.aero]) if (m) { group.remove(m); m.geometry.dispose(); stats.tris -= t.mesh === m ? m.geometry.attributes.position.count / 3 : 0; }
    tiles.delete(t.k);
  }
  function update(cam) {
    if (!enabled || typeof Globe === 'undefined') { group.visible = false; return; }
    frameNo++;
    if (!worker) { const blob = new Blob([WORKER], { type: 'text/javascript' }); worker = new Worker(URL.createObjectURL(blob)); worker.onmessage = received; Env.scene.add(group); }
    const p = cam.position, ll = Globe.w2ll(p.x, p.z), gy = typeof Player !== 'undefined' ? Player.groundAt(p.x, p.z) : 0, agl = p.y - gy;
    group.visible = agl < 4500;
    if (agl < 3500 && (frameNo & 7) === 0) {
      const X = Math.floor(txf(ll.lon)), Y = Math.floor(tyf(ll.lat)), R = agl < 900 ? 2 : 1;
      const want = []; for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) want.push([X + i, Y + j, i * i + j * j]);
      want.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of want) { const t = tiles.get(x + '/' + y); if (t) t.used = frameNo; else if (busy < 2) request(x, y); }
    }
    for (const t of tiles.values()) { if (t.state === 2) place(t); }
    if ((frameNo & 63) === 0) for (const t of [...tiles.values()]) if (frameNo - t.used > 600 && t.state !== 1) drop(t);
  }
  return { update, group, stats, get enabled() { return enabled; }, set enabled(v) { enabled = !!v; if (!v) group.visible = false; } };
})();
