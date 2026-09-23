// Airports: 28k airports and 33k runways of the world (OurAirports, public domain; baked by tools/bake_airports.py),
// search, runway geometry, and the runways themselves near the camera: asphalt with procedural markings
// (threshold bars, designations, centreline, touchdown zone, aiming points, edges), edge / threshold / end /
// centreline lights, approach lights with a sequenced "rabbit", and PAPI whose colours follow your glide angle.
// The globe flattens its terrain under drawn runways; in the Bayline square the runway follows Bayline's ground.
//   Airports.load()                        promise (idempotent)
//   Airports.search(q, n)                  [{ apt, score }] by ICAO / IATA / name / city
//   Airports.byIdent(id), Airports.nearest(lat, lon, filter)
//   Airports.runwayEnd(apt, rw, end)       threshold geometry in the current frame (for spawning)
//   Airports.groundAt(x, z)                runway surface height or null (physics)
//   Airports.update(camera)                build / light the airports near the camera
const Airports = (() => {
  const DEG = Math.PI / 180, FT = 0.3048;
  let list = null, loading = null, countries = {};
  const byId = new Map(); const grid = new Map();          // 1 degree cells -> airports
  const group = new THREE.Group(); group.name = 'airports'; group.layers.enable(1);
  const stats = { built: 0, lights: 0 };
  const cellKey = (lat, lon) => Math.floor(lat) * 1000 + Math.floor(lon);

  function load() {
    if (loading) return loading;
    loading = Stream.json('air/airports.json', 4).then((d) => {
      countries = d.countries || {};
      list = d.a.map((r, i) => {
        const a = { i, ident: r[0], iata: r[1], name: r[2], city: r[3], country: r[4], type: r[5], lat: r[6], lon: r[7], elev: r[8] * FT, twr: r[9], built: null,
          runways: r[10].map(w => ({ le: w[0], he: w[1], la: w[2], oa: w[3], lb: w[4], ob: w[5], ea: w[6] * FT, eb: w[7] * FT, L: w[8] * FT, W: Math.max(w[9] * FT, 10), surf: w[10], lit: w[11], da: w[12] * FT, db: w[13] * FT, approx: w[14] })) };
        a.lower = (a.name + ' ' + a.city).toLowerCase();
        byId.set(a.ident, a); if (a.iata) byId.set('@' + a.iata, a);
        const k = cellKey(a.lat, a.lon); let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(a);
        return a;
      });
      for (const f of loadedFns) f(); return list;
    });
    return loading;
  }
  const loadedFns = []; const onLoaded = (f) => { loadedFns.push(f); if (list) f(); };

  // ------------------------------------------------------------------ search / queries
  const COUNTRY = (c) => countries[c] || c;
  function search(q, n = 12) {
    if (!list) return [];
    q = (q || '').trim(); if (!q) return [];
    const Q = q.toUpperCase(), ql = q.toLowerCase(), out = [];
    for (const a of list) {
      let s = 0;
      if (a.ident === Q || a.iata === Q) s = 1000;
      else if (a.ident.startsWith(Q) || (a.iata && a.iata.startsWith(Q))) s = 400;
      else { const i = a.lower.indexOf(ql); if (i === 0) s = 300; else if (i > 0) s = a.lower[i - 1] === ' ' ? 220 : 120; }
      if (!s) continue;
      s += (2 - a.type) * 60 + (a.iata ? 20 : 0);
      out.push({ apt: a, score: s });
    }
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, n);
  }
  function byIdent(id) { return byId.get(String(id).toUpperCase()) || byId.get('@' + String(id).toUpperCase()) || null; }
  function hav(la1, lo1, la2, lo2) {
    const p1 = la1 * DEG, p2 = la2 * DEG, dp = p2 - p1, dl = (lo2 - lo1) * DEG;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function near(lat, lon, r, filter) {       // airports within r metres, nearest first
    const out = []; if (!list) return out;
    const dl = Math.ceil(r / 111000) + 1, dlo = Math.ceil(r / (111000 * Math.max(0.1, Math.cos(lat * DEG)))) + 1;
    for (let i = -dl; i <= dl; i++) for (let j = -dlo; j <= dlo; j++) {
      const c = grid.get(cellKey(lat + i, lon + j)); if (!c) continue;
      for (const a of c) { if (filter && !filter(a)) continue; const d = hav(lat, lon, a.lat, a.lon); if (d <= r) out.push({ apt: a, d }); }
    }
    out.sort((x, y) => x.d - y.d); return out;
  }
  function nearest(lat, lon, filter, r = 400000) { const n = near(lat, lon, r, filter); return n.length ? n[0] : null; }
  function label(a) { return `${a.ident}${a.iata && a.iata !== a.ident ? ' / ' + a.iata : ''} · ${a.name}`; }

  // ------------------------------------------------------------------ runway geometry in the current frame
  function bearing(la1, lo1, la2, lo2) { const p1 = la1 * DEG, p2 = la2 * DEG, dl = (lo2 - lo1) * DEG;
    return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / DEG + 360) % 360; }
  function geom(a, rw) {            // cached per frame id
    if (rw.g && rw.g.fid === Globe.frame.id) return rw.g;
    const A = Globe.ll2w(rw.la, rw.oa), B = Globe.ll2w(rw.lb, rw.ob);
    const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1;
    rw.g = { fid: Globe.frame.id, ax: A.x, az: A.z, bx: B.x, bz: B.z, ux: dx / len, uz: dz / len, len,
      hdg: bearing(rw.la, rw.oa, rw.lb, rw.ob) };             // true heading from LE toward HE
    return rw.g;
  }
  // surface elevation profile along the runway (u in metres from the LE end)
  function profile(a, rw, u) {
    const t = U.clamp(u / Math.max(rw.g ? rw.g.len : rw.L, 1), 0, 1);
    if (rw.bay) return rw.bay.h0 + (rw.bay.h1 - rw.bay.h0) * t;
    return rw.ea + (rw.eb - rw.ea) * t;
  }
  // in the Bayline square the runway rests on Bayline's own ground (a straight fit through it)
  function fitBay(a, rw) {
    const g = geom(a, rw); let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let i = 0; i <= 24; i++) { const u = g.len * i / 24, x = g.ax + g.ux * u, z = g.az + g.uz * u, h = Terrain.h(x, z); sx += u; sy += h; sxx += u * u; sxy += u * h; n++; }
    const b = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx), c = (sy - b * sx) / n;
    rw.bay = { h0: c, h1: c + b * g.len, t: performance.now() };
  }
  const inBay = (a) => Globe.frame.bay && Globe.inBayline(Globe.ll2w(a.lat, a.lon).x, Globe.ll2w(a.lat, a.lon).z);
  // local runway coordinates of a point: u along from LE, v across (right of LE->HE)
  function rwLocal(g, x, z) { const px = x - g.ax, pz = z - g.az; return [px * g.ux + pz * g.uz, -px * g.uz + pz * g.ux]; }
  function groundAt(x, z) {
    let best = null;
    for (const a of live) for (const rw of a.runways) {
      if (rw.approx || rw.surf === 2) continue;
      const g = geom(a, rw); const [u, v] = rwLocal(g, x, z);
      if (u < -8 || u > g.len + 8 || Math.abs(v) > rw.W / 2 + 4) continue;
      let h = profile(a, rw, u); if (rw.bay) h = Math.max(h, Terrain.h(x, z) + 0.03);
      if (best === null || h > best) best = h;
    }
    return best;
  }
  function runwayEnd(a, rw, end) {  // end 0 = LE, 1 = HE: threshold point, heading (true), elevation, direction in frame
    const g = geom(a, rw); const s = end ? -1 : 1, disp = end ? rw.db : rw.da;
    const u = end ? g.len - disp : disp;
    const x = g.ax + g.ux * u, z = g.az + g.uz * u;
    return { x, z, ux: g.ux * s, uz: g.uz * s, hdg: (g.hdg + (end ? 180 : 0)) % 360, elev: profile(a, rw, u), ident: end ? rw.he : rw.le, len: g.len - rw.da - rw.db, u };
  }

  // ------------------------------------------------------------------ terrain flattening for the globe
  // drawn runways by 1-degree cell, with what the globe needs per vertex (cached)
  const fcache = new Map();
  function cellRunways(i, j) {
    const k = i * 1000 + j; let L = fcache.get(k); if (L) return L; L = [];
    const c = grid.get(k);
    if (c) for (const a of c) for (const rw of a.runways) {
      if (rw.approx || rw.surf === 2) continue;
      const mla = 111132.954 - 559.822 * Math.cos(2 * rw.la * DEG), mlo = 111412.84 * Math.cos(rw.la * DEG);
      const ex = (rw.ob - rw.oa) * mlo, ez = (rw.lb - rw.la) * mla, len = Math.hypot(ex, ez) || 1, m = 0.004;
      L.push({ la: rw.la, oa: rw.oa, mla, mlo, ux: ex / len, uz: ez / len, len, hw: rw.W / 2, ea: rw.ea, eb: rw.eb,
        s: Math.min(rw.la, rw.lb) - m, n: Math.max(rw.la, rw.lb) + m, w: Math.min(rw.oa, rw.ob) - m * 1.4, e: Math.max(rw.oa, rw.ob) + m * 1.4 });
    }
    fcache.set(k, L); return L;
  }
  function runwaysIn(latS, latN, lonW, lonE) {
    if (!list || latN - latS > 1.2 || lonE - lonW > 1.6) return null;
    let out = null;
    for (let i = Math.floor(latS) - 1; i <= Math.floor(latN) + 1; i++) for (let j = Math.floor(lonW) - 1; j <= Math.floor(lonE) + 1; j++)
      for (const r of cellRunways(i, j)) if (r.n >= latS && r.s <= latN && r.e >= lonW && r.w <= lonE) (out || (out = [])).push(r);
    return out;
  }
  // blend a terrain height toward the runway profile near the runway (lat/lon of a globe vertex)
  function flattenH(F, lat, lon, h) {
    for (const r of F) {
      const px = (lon - r.oa) * r.mlo, pz = (lat - r.la) * r.mla;
      const u = px * r.ux + pz * r.uz, v = -px * r.uz + pz * r.ux;
      const du = Math.max(0, -u, u - r.len), dv = Math.max(0, Math.abs(v) - r.hw - 25);
      const d = Math.hypot(du, dv); if (d > 260) continue;
      const w = 1 - U.smooth(0, 260, d);
      const p = r.ea + (r.eb - r.ea) * U.clamp(u / r.len, 0, 1);
      h = h + (p - 0.05 - h) * w;
    }
    return h;
  }

  // ------------------------------------------------------------------ runway surface (procedural markings)
  let rwMat = null;
  function runwayMaterial() {
    if (rwMat) return rwMat;
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    m.customProgramCacheKey = () => 'bl-runway-v1';
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uGround = { value: Terrain.groundDetail ? Terrain.groundDetail() : null };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aRw; attribute vec4 aRwInfo; varying vec2 vRw; varying vec4 vRwInfo;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRw = aRw; vRwInfo = aRwInfo;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          uniform sampler2D uGround; varying vec2 vRw; varying vec4 vRwInfo;
          float rh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float rn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(rh(i), rh(i+vec2(1,0)), f.x), mix(rh(i+vec2(0,1)), rh(i+vec2(1,1)), f.x), f.y); }
          // antialiased box: 1 inside [a, b] (world metres), footprint w
          float bx(float x, float a, float b, float w) { return clamp(min(x - a, b - x) / w + 0.5, 0.0, 1.0); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float u = vRw.x, v = vRw.y, L = vRwInfo.x, W = vRwInfo.y, da = vRwInfo.z, db = vRwInfo.w;
            vec2 fw = fwidth(vRw) + 1e-4; float aw = max(fw.x, fw.y);
            vec2 gd = (texture2D(uGround, vRw / 2.5).ra - 0.5);
            // asphalt: aggregate, resurfacing patches, rubber deposits in both touchdown zones, oil down the centre
            vec3 base = vec3(0.22, 0.22, 0.215) * (0.93 + 0.12 * rn(vRw * vec2(0.02, 0.12)) + gd.x * 1.2);
            float td = max(bx(u, da + 250.0, da + 950.0, 60.0), bx(u, L - db - 950.0, L - db - 250.0, 60.0)) * (1.0 - smoothstep(W * 0.15, W * 0.32, abs(v)));
            base *= 1.0 - 0.45 * td * (0.6 + 0.4 * rn(vRw * vec2(0.08, 0.6)));
            base *= 1.0 - 0.08 * (1.0 - smoothstep(0.5, 2.5, abs(v)));
            float paint = 0.0, fade = 1.0 - smoothstep(0.4, 2.0, aw);   // markings average out far away
            float hw = W * 0.5, s = max(W, 30.0);
            // edges
            paint = max(paint, bx(abs(v), hw - 1.9, hw - 1.0, aw) * step(40.0, W));
            // each end: threshold bars, designation zone (decals), aiming point, touchdown zone, centreline
            for (int e = 0; e < 2; e++) {
              float d = e == 0 ? u - da : (L - db) - u;               // metres past this end's threshold
              float bars = W >= 44.0 ? 8.0 : W >= 29.0 ? 6.0 : 4.0;
              float bw = min(1.8, (hw - 3.0) / bars * 0.55), pitch = (hw - 3.0) / bars;
              float k = (abs(v) - 1.8) / pitch; float kb = step(0.0, abs(v) - 1.8) * step(abs(v), hw - 3.0) * bx(fract(k) * pitch, 0.0, bw, aw);
              paint = max(paint, kb * bx(d, 6.0, 51.0, aw));
              paint = max(paint, bx(d, 0.0, 1.0, aw) * step(abs(v), hw - 1.0) * step(40.0, W));               // threshold line
              // aiming point: two broad bars at 400 m
              paint = max(paint, bx(d, 400.0, 445.0, aw) * bx(abs(v), hw * 0.28, hw * 0.28 + min(9.0, W * 0.2), aw) * step(35.0, W));
              // touchdown zone bars (3-3-2-2-1-1 pairs) every 150 m out to 900 m
              float tdz = 0.0;
              for (int j = 1; j <= 6; j++) { float at = 150.0 * float(j); if (at == 450.0) continue;
                float nb = j <= 2 ? 3.0 : j <= 4 ? 2.0 : 1.0; float x0 = hw * 0.2;
                for (int q = 0; q < 3; q++) { if (float(q) >= nb) break; tdz = max(tdz, bx(d, at, at + 22.5, aw) * bx(abs(v), x0 + float(q) * 2.9, x0 + float(q) * 2.9 + 1.8, aw)); } }
              paint = max(paint, tdz * step(44.0, W));
              // displaced threshold area: arrows reduced to a dashed centre line
              if (d < 0.0) paint = max(paint, bx(fract(-d / 30.0) * 30.0, 0.0, 15.0, aw) * bx(abs(v), 0.0, 0.5, aw));
            }
            // centreline: 36 m dashes, 24 m gaps, between the designation zones
            float cz = step(da + 120.0, u) * step(u, L - db - 120.0);
            paint = max(paint, cz * bx(fract((u - da) / 60.0) * 60.0, 0.0, 36.0, aw) * bx(abs(v), 0.0, 0.46, aw));
            paint *= mix(0.72, 1.0, fade) * (0.86 + 0.14 * rn(vRw * vec2(0.3, 2.0)));
            diffuseColor.rgb = mix(base, vec3(0.86, 0.86, 0.83), paint);
          }`);
    };
    return (rwMat = m);
  }
  function runwayMesh(a, rw) {
    const g = geom(a, rw); const nU = Math.max(2, Math.ceil(g.len / 30)), nV = 4, W = rw.W + 8;   // + shoulders
    const pos = [], rwa = [], info = [], idx = [];
    const cx = (g.ax + g.bx) / 2, cz = (g.az + g.bz) / 2;
    for (let i = 0; i <= nU; i++) for (let j = 0; j <= nV; j++) {
      const u = g.len * i / nU, v = (j / nV - 0.5) * W, x = g.ax + g.ux * u - g.uz * v, z = g.az + g.uz * u + g.ux * v;
      let h = profile(a, rw, u); if (rw.bay) h = Math.max(h, Terrain.h(x, z) + 0.03);
      pos.push(x - cx, h + 0.04, z - cz); rwa.push(u, v); info.push(g.len, rw.W, rw.da, rw.db);
    }
    for (let i = 0; i < nU; i++) for (let j = 0; j < nV; j++) { const p = i * (nV + 1) + j; idx.push(p, p + 1, p + nV + 1, p + 1, p + nV + 2, p + nV + 1); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('aRw', new THREE.Float32BufferAttribute(rwa, 2)); geo.setAttribute('aRwInfo', new THREE.Float32BufferAttribute(info, 4));
    geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, runwayMaterial()); m.position.set(cx, 0, cz); m.receiveShadow = true; m.layers.enable(1); m.renderOrder = -2;
    return m;
  }
  // designations: a canvas decal per runway end ("28", "R")
  function designation(ident, W) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 256); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const num = ident.replace(/[^0-9]/g, ''), let_ = ident.replace(/[0-9]/g, '');
    g.font = '700 118px "Barlow Condensed", "Arial Narrow", sans-serif';
    if (let_) { g.fillText(num, 64, 64, 124); g.fillText(let_, 64, 196, 124); } else g.fillText(num, 64, 128, 124);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  let decalMat = null;
  function decalMesh(a, rw, end) {
    const e = runwayEnd(a, rw, end); const W = rw.W; if (W < 18) return null;
    const hgt = Math.min(38, W * 0.75), wid = hgt * 0.5, d = 60 + hgt / 2;
    const geo = new THREE.PlaneGeometry(wid, hgt); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: designation(e.ident, W), transparent: true, roughness: 0.86, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, depthWrite: false }));
    const x = e.x + e.ux * d, z = e.z + e.uz * d;
    let h = profile(a, rw, end ? e.u - d : e.u + d); if (rw.bay) h = Math.max(h, Terrain.h(x, z) + 0.03);
    m.position.set(x, h + 0.06, z); m.rotation.y = Math.atan2(-e.ux, -e.uz) + Math.PI;   // text reads toward the approach
    m.layers.enable(1); m.renderOrder = -1;
    return m;
  }

  // ------------------------------------------------------------------ lights (instanced, directional, PAPI)
  // per light: position, colour, kind (0 omni, 1 directional, 2 PAPI, 3 rabbit), direction (xz), param
  let lightMat = null;
  function lightMaterial() {
    if (lightMat) return lightMat;
    lightMat = new THREE.ShaderMaterial({
      uniforms: { uNight: U.uNight, uTime: U.uTime },
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec2 aCorner; attribute vec4 aL; attribute vec4 aC; attribute vec4 aD;
        uniform float uNight; uniform float uTime; varying vec2 vUv; varying vec3 vCol;
        void main() {
          vec4 wp = modelMatrix * vec4(aL.xyz, 1.0);
          vec3 toCam = cameraPosition - wp.xyz; float dist = length(toCam); vec3 vd = toCam / max(dist, 1e-3);
          vec3 col = aC.rgb; float I = aC.a;
          float kind = aD.w;
          if (kind > 0.5 && kind < 1.5) I *= smoothstep(-0.1, 0.35, dot(normalize(vec3(aD.x, 0.0, aD.y)), normalize(vec3(vd.x, 0.0, vd.z))));   // directional
          if (kind > 1.5 && kind < 2.5) {           // PAPI: red below the unit's transition angle, white above
            float ang = degrees(atan(toCam.y, length(toCam.xz)));
            col = mix(vec3(1.0, 0.08, 0.04), vec3(1.0, 0.96, 0.9), smoothstep(aD.z - 0.06, aD.z + 0.06, ang));
            I *= smoothstep(-0.3, 0.2, dot(normalize(vec3(aD.x, 0.0, aD.y)), normalize(vec3(vd.x, 0.0, vd.z))));
          }
          if (kind > 2.5) I *= step(0.9, fract(uTime * 2.0 - aD.z));   // sequenced flasher (twice a second)
          I *= 0.18 + 0.82 * uNight;
          vec4 mv = blBend(viewMatrix * wp);
          float size = max(aL.w, -mv.z * 0.0011);
          I *= clamp(aL.w / size, 0.12, 1.0) * (0.55 + 0.45 * clamp(I, 0.0, 1.0));   // a lamp smaller than a pixel keeps its power, not its size
          mv.xy += aCorner * size;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          vUv = aCorner; vCol = col * I;
          if (I < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv; varying vec3 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv); float a = exp(-r * r * 5.0) + 0.35 * exp(-r * r * 1.2); if (a < 0.01) discard;
          gl_FragColor = vec4(vCol * a * 1.3, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    return lightMat;
  }
  function lightsMesh(a) {
    const L = [];        // [x, y, z, size, r, g, b, I, dx, dz, p, kind]
    const push = (x, y, z, size, col, I, dx = 0, dz = 0, p = 0, kind = 0) => L.push([x, y, z, size, col[0], col[1], col[2], I, dx, dz, p, kind]);
    const WHITE = [1, 0.93, 0.8], YEL = [1, 0.78, 0.35], GREEN = [0.2, 1, 0.45], RED = [1, 0.08, 0.04];
    const precision = a.type === 0;
    for (const rw of a.runways) {
      if (rw.approx || rw.surf === 2 || (!rw.lit && a.type === 2)) continue;
      const g = geom(a, rw); const hw = rw.W / 2 + 1.5;
      const at = (u, v) => { const x = g.ax + g.ux * u - g.uz * v, z = g.az + g.uz * u + g.ux * v; let h = profile(a, rw, U.clamp(u, 0, g.len)); if (rw.bay) h = Math.max(h, Terrain.h(x, z)); return [x, h + 0.35, z]; };
      // edge lights every 60 m, yellow on the last 600 m (instrument runways)
      for (let u = 0; u <= g.len + 0.1; u += 60) for (const s of [-1, 1]) { const p = at(u, s * hw); const yel = precision && (u < 600 || u > g.len - 600); push(p[0], p[1], p[2], 0.5, yel ? YEL : WHITE, 0.9); }
      // threshold (green toward the approach) and end (red toward the runway) bars at both ends
      for (const end of [0, 1]) {
        const e = runwayEnd(a, rw, end);
        for (let v = -rw.W / 2; v <= rw.W / 2 + 0.1; v += 3) {
          const p = at(e.u, v); push(p[0], p[1] - 0.2, p[2], 0.5, GREEN, 1.2, -e.ux, -e.uz, 0, 1);
          const q = at(end ? 0 : g.len, v); push(q[0], q[1] - 0.2, q[2], 0.45, RED, 1.0, -e.ux, -e.uz, 0, 1);
        }
        // PAPI: four units left of the touchdown zone; the unit nearest the runway switches highest
        const pu = e.u + (end ? -1 : 1) * Math.min(300, g.len * 0.18);
        for (let k = 0; k < 4; k++) { const side = -1; const v = (hw + 15 + k * 9) * side * (end ? -1 : 1); const p = at(pu, v); push(p[0], p[1] + 0.4, p[2], 0.75, RED, 1.4, -e.ux, -e.uz, 3.5 - k * 0.333, 2); }
        // approach lights (large airports): barrettes every 30 m out to 720 m, a crossbar at 300 m, a rabbit
        if (precision && rw.lit) {
          for (let d = 30; d <= 720; d += 30) {
            const u = e.u - (end ? -1 : 1) * d; const x0 = g.ax + g.ux * u, z0 = g.az + g.uz * u; const hh = Math.max(profile(a, rw, U.clamp(u, 0, g.len)), 0) + 0.6 + d * 0.004;
            for (let v = -2; v <= 2; v++) push(x0 - g.uz * v * 1.1, hh, z0 + g.ux * v * 1.1, 0.55, WHITE, 1.1, -e.ux, -e.uz, 0, 1);
            if (d === 300) for (let v = -7; v <= 7; v++) if (Math.abs(v) > 2) push(x0 - g.uz * v * 1.5, hh, z0 + g.ux * v * 1.5, 0.55, WHITE, 1.1, -e.ux, -e.uz, 0, 1);
            if (d >= 330) push(x0, hh + 0.5, z0, 1.1, [1, 1, 1], 3.0, -e.ux, -e.uz, (720 - d) / 720 * 0.9, 3);
          }
        }
      }
      // centreline lights on wide runways: white, then alternating red/white, the last 300 m red (each direction)
      if (rw.W >= 44 && rw.lit) for (let u = 15; u < g.len - 10; u += 15) {
        const p = at(u, 0.6); const toB = g.len - u, toA = u;
        const cB = toB < 300 ? RED : toB < 900 && ((u / 15) | 0) % 2 ? RED : WHITE, cA = toA < 300 ? RED : toA < 900 && ((u / 15) | 0) % 2 ? RED : WHITE;
        push(p[0], p[1] - 0.3, p[2], 0.32, cB, 0.8, -g.ux, -g.uz, 0, 1); push(p[0], p[1] - 0.3, p[2], 0.32, cA, 0.8, g.ux, g.uz, 0, 1);
      }
    }
    if (!L.length) return null;
    const cx = L.reduce((s, l) => s + l[0], 0) / L.length, cz = L.reduce((s, l) => s + l[2], 0) / L.length;
    const n = L.length, P = new Float32Array(n * 16), Ca = new Float32Array(n * 8), Lp = new Float32Array(n * 16), Cc = new Float32Array(n * 16), Dd = new Float32Array(n * 16), idx = [];
    L.forEach((l, i) => {
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 4; Lp[o] = l[0] - cx; Lp[o + 1] = l[1]; Lp[o + 2] = l[2] - cz; Lp[o + 3] = l[3];
        Cc[o] = l[4]; Cc[o + 1] = l[5]; Cc[o + 2] = l[6]; Cc[o + 3] = l[7]; Dd[o] = l[8]; Dd[o + 1] = l[9]; Dd[o + 2] = l[10]; Dd[o + 3] = l[11];
      }
      Ca.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8); idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 12), 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(Ca, 2)); geo.setAttribute('aL', new THREE.BufferAttribute(Lp, 4));
    geo.setAttribute('aC', new THREE.BufferAttribute(Cc, 4)); geo.setAttribute('aD', new THREE.BufferAttribute(Dd, 4)); geo.setIndex(idx);
    const m = new THREE.Mesh(geo, lightMaterial()); m.position.set(cx, 0, cz); m.frustumCulled = false; m.renderOrder = 6; m.layers.enable(1);
    stats.lights += n; return m;
  }

  // ------------------------------------------------------------------ build / keep the airports near the camera
  const live = new Set(); let tick = 0;
  function build(a) {
    const g = new THREE.Group(); g.name = 'apt-' + a.ident; g.layers.enable(1);
    a.bay = inBay(a);
    for (const rw of a.runways) { rw.bay = null; if (a.bay && !rw.approx) fitBay(a, rw); }
    for (const rw of a.runways) {
      if (rw.approx || rw.surf === 2) continue;
      g.add(runwayMesh(a, rw));
      for (const end of [0, 1]) { const d = decalMesh(a, rw, end); if (d) g.add(d); }
    }
    const lm = lightsMesh(a); if (lm) g.add(lm);
    a.built = { g, fid: Globe.frame.id, t: performance.now() }; group.add(g); stats.built++;
  }
  function unbuild(a) {
    if (!a.built) return; group.remove(a.built.g);
    a.built.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== rwMat && o.material !== lightMat) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    a.built = null;
  }
  function update(cam) {
    if (!list) return;
    if ((tick++ & 15) !== 0) return;             // a few times a second is plenty
    const ll = Globe.w2ll(cam.position.x, cam.position.z);
    const R = 26000 + Math.min(cam.position.y * 3, 40000);
    const want = new Set(near(ll.lat, ll.lon, R).map(n => n.apt).filter(a => a.runways.some(r => !r.approx)));
    for (const a of [...live]) if (!want.has(a) || (a.built && a.built.fid !== Globe.frame.id)) { unbuild(a); live.delete(a); }
    let budget = 2;
    for (const a of want) {
      if (a.built && a.bay && performance.now() - a.built.t > 9000 && !a.built.refit) { unbuild(a); a.refitDone = true; build(a); a.built.refit = true; }   // Bayline ground has streamed in
      if (!a.built && budget-- > 0) { build(a); live.add(a); }
    }
  }
  function init() { Env.scene.add(group); }
  return { init, load, onLoaded, search, byIdent, near, nearest, label, runwayEnd, geom, groundAt, runwaysIn, flattenH, update, group, stats, COUNTRY,
    get list() { return list; }, hav, bearing };
})();
