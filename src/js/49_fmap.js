// FMap: the world map (M while flying or anywhere away from the Bay). Sentinel-2 cloudless imagery (EOX) in web mercator
// with your aircraft and its track, live traffic, airports (runways drawn when zoomed in), wheel to zoom, drag to pan.
// Click an airport to fly from it.
const FMap = (() => {
  const D = Math.PI / 180, NM = 1852, FT = 0.3048, KT = 0.514444;
  let el = null, cv = null, g = null, open = false, view = { lat: 0, lon: 0, z: 8 }, drag = null, follow = true, hover = null;
  const trail = []; let trailT = 0;
  const tiles = new Map(); let useN = 0;
  const URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${y}/${x}.jpg`;
  const tx = (lon, z) => (lon + 180) / 360 * 2 ** z, ty = (lat, z) => { const r = Math.max(-85, Math.min(85, lat)) * D; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  const lonOf = (x, z) => x / 2 ** z * 360 - 180, latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / D;
  function tile(z, x, y) {
    const k = z + '/' + x + '/' + y; let t = tiles.get(k);
    if (t) { t.used = ++useN; return t.img; }
    t = { img: null, used: ++useN }; tiles.set(k, t);
    fetch(URL(z, x, y), { mode: 'cors', credentials: 'omit' }).then(r => r.ok ? r.blob() : Promise.reject()).then(b => createImageBitmap(b)).then(b => { t.img = b; }, () => {});
    if (tiles.size > 220) { const old = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 60); for (const [k2, v] of old) { if (v.img && v.img.close) v.img.close(); tiles.delete(k2); } }
    return null;
  }
  function build() {
    el = document.createElement('div'); el.className = 'fov'; el.hidden = true;
    el.innerHTML = `<div class="card panel" style="width:min(1280px,96vw);padding:14px 16px"><button class="close" data-x>×</button><div class="kicker">World map</div>
      <canvas style="width:100%;height:76vh;display:block;border-radius:10px;background:#0c1116;cursor:grab"></canvas>
      <p class="fnote" style="margin:8px 0 0">Wheel to zoom, drag to pan, double-click to follow the aircraft again. Click an airport to fly from it. Imagery: EOxCloudless 2025 (EOX IT Services GmbH, contains modified Copernicus Sentinel data); traffic: adsb.lol.</p></div>`;
    document.body.appendChild(el); cv = el.querySelector('canvas'); g = cv.getContext('2d');
    el.querySelector('[data-x]').onclick = () => toggle(false);
    el.addEventListener('mousedown', (e) => { if (e.target === el) toggle(false); });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * dpr(), my = (e.clientY - r.top) * dpr();
      const before = unproject(mx, my); view.z = Math.max(2, Math.min(15, view.z + (e.deltaY > 0 ? -0.35 : 0.35))); const after = unproject(mx, my);
      view.lat += before.lat - after.lat; view.lon += before.lon - after.lon; follow = false; }, { passive: false });
    cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
    window.addEventListener('mousemove', (e) => { if (!open) return;
      const r = cv.getBoundingClientRect(); hover = { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() };
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
      const s = 256 * 2 ** view.z; const X = tx(view.lon, 0) * s - dx * dpr(), Y = ty(view.lat, 0) * s - dy * dpr(); view.lon = lonOf(X / s, 0); view.lat = latOf(Y / s, 0); follow = false; });
    window.addEventListener('mouseup', (e) => { if (!drag || !open) { drag = null; return; } const click = drag.moved < 5; drag = null; if (click) clickAt(e); });
    cv.addEventListener('dblclick', () => { follow = true; });
  }
  const dpr = () => Math.min(2, devicePixelRatio || 1);
  function project(lat, lon) { const s = 256 * 2 ** view.z; return [(tx(lon, 0) - tx(view.lon, 0)) * s + cv.width / 2, (ty(lat, 0) - ty(view.lat, 0)) * s + cv.height / 2]; }
  function unproject(px, py) { const s = 256 * 2 ** view.z; return { lon: lonOf(tx(view.lon, 0) + (px - cv.width / 2) / s, 0), lat: latOf(ty(view.lat, 0) + (py - cv.height / 2) / s, 0) }; }
  function here() { const p = typeof Flight !== 'undefined' && Flight.active ? Flight.ac.pos : Env.camera.position; return Globe.w2ll(p.x, p.z); }
  function toggle(v) {
    if (!el) build();
    open = v === undefined ? !open : v; el.hidden = !open;
    if (open) { const r = cv.getBoundingClientRect(); cv.width = r.width * dpr(); cv.height = r.height * dpr(); const ll = here(); view.lat = ll.lat; view.lon = ll.lon;
      const alt = typeof Flight !== 'undefined' && Flight.active ? Flight.ac.pos.y : Env.camera.position.y; view.z = alt > 8000 ? 7 : alt > 2000 ? 9 : 11; follow = true; Player.releaseLock && Player.releaseLock(); }
  }
  function airportsInView() {
    const c = unproject(cv.width / 2, cv.height / 2), e = unproject(cv.width, cv.height / 2);
    const r = Math.min(900000, Airports.hav(c.lat, c.lon, e.lat, e.lon) * 1.5);
    return Airports.near(c.lat, c.lon, r, a => view.z >= 9 || a.type === 0 || (view.z >= 7 && a.type === 1)).slice(0, 400);
  }
  function clickAt(e) {
    const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * dpr(), my = (e.clientY - r.top) * dpr();
    let best = null, bd = 14 * dpr();
    for (const n of airportsInView()) { const [x, y] = project(n.apt.lat, n.apt.lon); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = n.apt; } }
    if (best) { toggle(false); FHud.setup(true); FHud.pick(best); }
  }
  function record(dt) {
    if (typeof Flight === 'undefined' || !Flight.active) return;
    trailT -= dt; if (trailT > 0) return; trailT = 2;
    const ll = Globe.w2ll(Flight.ac.pos.x, Flight.ac.pos.z); trail.push([ll.lat, ll.lon, Flight.ac.pos.y]); if (trail.length > 4000) trail.shift();
  }
  function draw() {
    if (!open) return;
    if (follow) { const ll = here(); view.lat = ll.lat; view.lon = ll.lon; }
    const W = cv.width, H = cv.height, z = Math.round(Math.min(14, Math.max(2, view.z))), s = 256 * 2 ** view.z, ts = s / 2 ** z;
    g.fillStyle = '#0c1116'; g.fillRect(0, 0, W, H);
    const cx = tx(view.lon, z), cy = ty(view.lat, z), nx = Math.ceil(W / ts / 2) + 1, ny = Math.ceil(H / ts / 2) + 1;
    for (let j = Math.floor(cy) - ny; j <= Math.floor(cy) + ny; j++) for (let i = Math.floor(cx) - nx; i <= Math.floor(cx) + nx; i++) {
      if (j < 0 || j >= 2 ** z) continue; const ii = ((i % 2 ** z) + 2 ** z) % 2 ** z;
      let img = tile(z, ii, j), zz = z, xx = ii, yy = j, sub = 1;
      while (!img && zz > 2) { zz--; xx >>= 1; yy >>= 1; sub *= 2; const t = tiles.get(zz + '/' + xx + '/' + yy); if (t && t.img) img = t.img; }
      const px = (i - cx) * ts + W / 2, py = (j - cy) * ts + H / 2;
      if (img) { if (sub === 1) g.drawImage(img, px, py, ts + 1, ts + 1); else { const sw = 256 / sub, sx = (ii - (xx << Math.log2(sub))) * sw, sy = (j - (yy << Math.log2(sub))) * sw; g.drawImage(img, sx, sy, sw, sw, px, py, ts + 1, ts + 1); } }
    }
    g.fillStyle = 'rgba(8,12,16,.18)'; g.fillRect(0, 0, W, H);
    const k = dpr();
    // airports (runways once they are big enough to see)
    g.font = `600 ${11 * k}px "IBM Plex Mono", monospace`; g.textBaseline = 'middle';
    let hov = null;
    for (const n of airportsInView()) {
      const a = n.apt, [x, y] = project(a.lat, a.lon); if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      if (view.z >= 11) { g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = Math.max(2, 256 * 2 ** view.z / 40075016 * 45) * 0.8; for (const rw of a.runways) { const p1 = project(rw.la, rw.oa), p2 = project(rw.lb, rw.ob); g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke(); } }
      g.fillStyle = a.type === 0 ? '#8cc8ff' : a.type === 1 ? '#c9e4ff' : '#9fb0bf'; g.beginPath(); g.arc(x, y, (a.type === 0 ? 5 : a.type === 1 ? 4 : 3) * k, 0, 7); g.fill();
      if (a.type === 0 || view.z >= 9) { g.fillStyle = '#e9f2fb'; g.fillText(a.ident, x + 8 * k, y); }
      if (hover && Math.hypot(hover.x - x, hover.y - y) < 12 * k) hov = a;
    }
    // traffic
    if (typeof Traffic !== 'undefined') for (const t of Traffic.targets.values()) {
      const ll = Globe.w2ll(t.pos.x, t.pos.z), [x, y] = project(ll.lat, ll.lon); if (x < 0 || y < 0 || x > W || y > H) continue;
      g.save(); g.translate(x, y); g.rotate(t.hdg); g.fillStyle = t.onGround ? '#b8c2cc' : '#ffd166'; g.beginPath(); g.moveTo(0, -6 * k); g.lineTo(4 * k, 5 * k); g.lineTo(0, 3 * k); g.lineTo(-4 * k, 5 * k); g.fill(); g.restore();
      if (view.z >= 9 && !t.onGround) { g.fillStyle = 'rgba(255,209,102,.9)'; g.font = `500 ${10 * k}px "IBM Plex Mono", monospace`; g.fillText(`${t.cs || t.type} ${Math.round(t.pos.y / FT / 100)}`, x + 7 * k, y - 6 * k); }
    }
    // trail and the aircraft
    if (trail.length > 1) { g.strokeStyle = 'rgba(255,90,60,.9)'; g.lineWidth = 2.5 * k; g.beginPath(); trail.forEach(([la, lo], i) => { const [x, y] = project(la, lo); i ? g.lineTo(x, y) : g.moveTo(x, y); }); const hh = here(), [xh, yh] = project(hh.lat, hh.lon); g.lineTo(xh, yh); g.stroke(); }
    const ll = here(), [x0, y0] = project(ll.lat, ll.lon);
    const hdg = typeof Flight !== 'undefined' && Flight.active ? Flight.euler.hdg : (() => { const d = Env.camera.getWorldDirection(new THREE.Vector3()); return Math.atan2(d.x, -d.z); })();
    g.save(); g.translate(x0, y0); g.rotate(hdg); g.fillStyle = '#ff5a3c'; g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k;
    g.beginPath(); g.moveTo(0, -12 * k); g.lineTo(9 * k, 9 * k); g.lineTo(0, 5 * k); g.lineTo(-9 * k, 9 * k); g.closePath(); g.fill(); g.stroke(); g.restore();
    if (hov) { const [x, y] = project(hov.lat, hov.lon); const txt = `${hov.ident} · ${hov.name} · ${Math.round(Math.max(...hov.runways.map(r => r.L)))} m · click to fly from here`; g.font = `600 ${12 * k}px Barlow, sans-serif`; const w = g.measureText(txt).width + 16 * k;
      g.fillStyle = 'rgba(10,12,16,.85)'; g.fillRect(x + 10 * k, y + 10 * k, w, 24 * k); g.fillStyle = '#fff'; g.fillText(txt, x + 18 * k, y + 22 * k); }
    // scale bar
    const mpp = 40075016 * Math.cos(view.lat * D) / s, nm = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find(v => v * NM / mpp > 90 * k) || 1000;
    g.fillStyle = '#fff'; g.fillRect(16 * k, H - 22 * k, nm * NM / mpp, 3 * k); g.font = `600 ${11 * k}px "IBM Plex Mono", monospace`; g.fillText(nm + ' nm', 16 * k, H - 34 * k);
  }
  function update(dt) { record(dt); draw(); }
  return { toggle, update, get open() { return open; }, trail };
})();
