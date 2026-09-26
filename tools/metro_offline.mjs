#!/usr/bin/env node
// Metro stations without a browser or a GPU (stations workstream QA while the GPU is reserved): the real source files of
// the stations stack (util, geo, data, the metro switch, Track, MetroNet, the Peninsula stations, MetroStations, the
// station kit, parts, signs, types and heroes) run in one Node vm scope, as build.py concatenates them, with stubs for
// the DOM (canvases draw nothing), the renderer (no interior environment map), the terrain (flat ground at --ground m)
// and the world (no Towns, Under or Flora). The data is the real data (core track, metro network, stations' OSM).
// Geometry and walk data are what the page builds (heights that follow the terrain do not); nothing is drawn.
//   node tools/metro_offline.mjs summary [IDS]          every (or the listed) station built: steps, floors, walls, triangles
//   node tools/metro_offline.mjs ends [IDS]             platform end faces seen from the trackway 12 m out: front / back hits
//   node tools/metro_offline.mjs gaps [IDS]             tools/metro_walk_gaps.js (walkable width along every platform)
//   node tools/metro_offline.mjs plan ID OUT.svg [U0 U1 V0 V1 PXPERM]   a top-down plan of the station's walk data
//   node tools/metro_offline.mjs eval FILE [ARGS_JSON]  a page probe (async (B, args) => value, as metro_shots' evalFile)
//   node tools/metro_offline.mjs peninsula [IDS]        the Peninsula stations' layouts (platforms, stops, door sides) and
//                                                       the listed ones built (meshes, triangles): compare --metro 0 / 1
// Options: --js DIR (the sources from another tree, e.g. `git archive <rev> src/js`), --metro 0 (the metro off),
// --ground 4.2. IDS: comma-separated. Always run it through tools/wd.py (a long build of all 52 stations takes ~30 s).
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const JS = opt('js', join(ROOT, 'src/js')), METRO = opt('metro', '1'), GROUND = +opt('ground', '4.2');
const [cmd, ...rest] = args;

export async function load() {
  const DATA = join(ROOT, 'data/pub/v2') + '/';
  const read = (p) => { const b = readFileSync(DATA + p); return b[0] === 0x78 ? inflateSync(b) : b; };
  const PROPS = new Set(['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign', 'textBaseline', 'globalAlpha', 'lineCap', 'lineJoin', 'filter', 'shadowBlur', 'shadowColor', 'globalCompositeOperation', 'imageSmoothingEnabled', 'letterSpacing']);
  const ctx2d = new Proxy({}, { get: (t, k) => k === 'measureText' ? (s) => ({ width: String(s).length * 10 })
    : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
    : k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern' ? () => ({ addColorStop() {} })
    : typeof k === 'string' && /^[a-z]/.test(k) && !PROPS.has(k) ? () => {} : undefined, set: () => true });
  const canvas = () => ({ width: 64, height: 64, style: {}, getContext: () => ctx2d, toDataURL: () => '', addEventListener() {} });
  const S = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, TextDecoder, TextEncoder, URLSearchParams, Math, Date, JSON, Promise, Map, Set, WeakMap, Symbol, Proxy, Reflect, Error, Object, Array, Number, String, Boolean,
    Float32Array, Float64Array, Int8Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Uint8ClampedArray, ArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt, Infinity, NaN,
    atob: (s) => Buffer.from(s, 'base64').toString('binary') };
  S.window = S; S.self = S; S.globalThis = S;
  const hash = '#metro=' + METRO;
  S.location = { hash, search: '', href: 'http://localhost/offline.html' + hash };
  S.navigator = { userAgent: 'node', hardwareConcurrency: 8 };
  S.document = { createElement: (k) => k === 'canvas' ? canvas() : { style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } },
    getElementById: () => null, body: { classList: { add() {}, remove() {} }, appendChild() {} }, addEventListener() {}, fonts: { load: async () => [] } };
  S.requestAnimationFrame = () => 0; S.addEventListener = () => {};
  vm.createContext(S);
  vm.runInContext(readFileSync(join(ROOT, 'vendor/three.min.js'), 'utf8'), S, { filename: 'three.min.js' });
  S.__read_json = (p) => JSON.parse(read(p).toString('utf8'));
  S.__read_bin = (p) => { const b = read(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
  vm.runInContext(`
    var Env = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null, state: { exposure: 1 }, time: { sec: 41400, scale: 1 }, setClock(s) { this.time.sec = s; } };
    var Terrain = { h: () => ${GROUND}, hBase: () => ${GROUND}, ensure: async () => {}, addHeightFilter: () => {}, isWater: () => false, cutTest: null };
    var Stream = { base: './data/v2/', json: async (p) => __read_json(p), bin: async (p) => __read_bin(p), stats: {} };`, S);
  const files = ['00_util.js', '01_geo.js', '02_data.js', '18_metro.js', '20_track.js', '21_metronet.js', '25_stations.js', '26_metrostations.js', '27_stationkit.js', '27_stationparts.js', '27_stationsigns.js', '27_stationtypes.js', '28_stationheroes.js'];
  // (no renderer: no interior environment map)
  const src = files.map(f => `// ===== ${f} =====\n` + readFileSync(join(JS, f), 'utf8')).join('\n').replace('if (envInterior) return envInterior;', 'if (envInterior) return envInterior; if (!renderer) return null;');
  vm.runInContext(`(function(){'use strict';\n${src}\nglobalThis.__M = { U, Geo, Metro, Track, Stations, MetroNet, MetroStations, StationKit, StationTypes };\n})();`, S, { filename: 'stations-stack.js' });
  const M = S.__M;
  await M.Track.load();
  M.Stations.init();                                     // (lays out the Peninsula stations; hooks MetroStations.init)
  if (M.Metro.on) await M.MetroStations.init();
  return { M, S };
}
// one metro station built to completion (the stepped generator run through), its walk data attached (floorAt, blocked)
export function build(M, id) {
  const MS = M.MetroStations, st = MS.byId[id]; if (!st) throw new Error('no station ' + id);
  if (!st.plan) st.plan = MS.makePlan(st.data);
  const C = { PLAT_H: MS.PLAT_H, EDGE: MS.EDGE, DU: 2, spineAt: MS.spineAt, trackV: MS.trackV, N: MS.net, lines: MS.net.lines(), renderer: null, stationsList: MS.list, q: MS.quality };
  const gen = M.StationTypes.build(st, C); let r = gen.next(), n = 0; while (!r.done) { r = gen.next(); n++; }
  const res = r.value; st.res = res; st.walk = res.walk; st.root = res.root; st.state = 'built'; return { st, res, steps: n };
}
const tris = (root) => { let t = 0; root.traverse(o => { if (o.isMesh && o.geometry) { const g = o.geometry; t += (g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0) / 3; } }); return Math.round(t); };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { M, S } = await load();
  const ids = (rest[0] && cmd !== 'plan' && cmd !== 'eval' ? rest[0].split(',') : null) || (M.MetroStations.list || []).map(s => s.id);
  if (cmd === 'summary') {
    let bad = 0; const t0 = Date.now();
    for (const id of ids) { const t1 = Date.now();
      try { const { res, steps } = build(M, id); console.log([id, steps, res.walk.floors.length, res.walk.walls.length, tris(res.root), Date.now() - t1].join(' ')); }
      catch (e) { bad++; console.log(id, 'ERROR', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }
    console.log('stations', ids.length, 'errors', bad, 'ms', Date.now() - t0);
  } else if (cmd === 'ends') {
    S.__build = (id) => build(M, id).res; S.__ids = ids;
    const r = vm.runInContext(`(() => { const MS = __M.MetroStations, out = { front: 0, back: 0, miss: 0, by: {} };
      for (const id of __ids) { const s = MS.byId[id]; let res; try { res = __build(id); } catch (e) { continue; } const root = res.root; root.updateMatrixWorld(true);
        const meshes = []; root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.material && !Array.isArray(o.material)) meshes.push(o); });
        const saved = meshes.map(m => m.material.side); for (const m of meshes) m.material.side = THREE.DoubleSide;
        const pl = s.plan, rc = new THREE.Raycaster(), n = new THREE.Vector3(); rc.far = 30; let f = 0, b = 0, mi = 0;
        for (const p of res.crowd.plats) { const t = pl.tracks.find(q => q.id === p.tracks[0]); if (!t) continue;
          for (const end of [-1, 1]) { const ue = end > 0 ? p.u1 : p.u0, uc = ue + end * 12, vt = MS.trackV(pl, t, uc), yR = p.y - (p.ph || 0.991);
            const [x0, z0] = res.toWorld(uc, vt), o = new THREE.Vector3(x0, yR + 1.6, z0);
            for (const dv of [-0.8, 0, 0.8]) { const [x1, z1] = res.toWorld(ue, (p.eL(ue) + p.eR(ue)) / 2 + dv), d = new THREE.Vector3(x1, p.y - 0.4, z1).sub(o).normalize(); rc.set(o, d);
              const h = rc.intersectObjects(meshes, false)[0]; if (!h || !h.face) { mi++; continue; } n.copy(h.face.normal).transformDirection(h.object.matrixWorld); if (n.dot(d) > 0) b++; else f++; } } }
        meshes.forEach((m, i) => { m.material.side = saved[i]; }); out.front += f; out.back += b; out.miss += mi; if (b) out.by[id] = [f, b, mi]; }
      return out; })()`, S);
    console.log('front', r.front, 'back', r.back, 'miss', r.miss, JSON.stringify(r.by));
  } else if (cmd === 'gaps' || cmd === 'eval') {
    const MS = M.MetroStations;
    const B = { Stations: M.Stations, Track: M.Track, Terrain: S.Terrain, Metro: M.Metro,
      MetroStations: new Proxy(MS, { get: (t, k) => k === 'shot' ? async (id) => { try { build(M, id); return { state: 'built' }; } catch (e) { return { state: 'failed', error: String(e) }; } } : t[k] }) };
    const file = cmd === 'gaps' ? join(ROOT, 'tools/metro_walk_gaps.js') : resolve(rest[0]);
    const a = cmd === 'gaps' ? { ids: rest[0] ? ids : null, min: 0.9, step: 0.5 } : JSON.parse(rest[1] || '{}');
    const f = vm.runInContext('(' + readFileSync(file, 'utf8') + ')', S);
    console.log(JSON.stringify(await f(B, a)));
  } else if (cmd === 'plan') {
    const [id, out, ua = '-110', ub = '110', va = '-30', vb = '30', k = '7'] = rest;
    const { st, res } = build(M, id);
    const pl = st.plan, SP = M.MetroStations.spineAt(pl, 0, {}), U0 = +ua, U1 = +ub, V0 = +va, V1 = +vb, K = +k, W = (U1 - U0) * K, H = (V1 - V0) * K;
    const toUV = (x, z) => { const dx = x - SP.x, dz = z - SP.z; return [dx * SP.tx + dz * SP.tz, dx * -SP.tz + dz * SP.tx]; };
    const px = (u, v) => [((u - U0) * K).toFixed(1), ((v - V0) * K).toFixed(1)], el = [];
    const ys = res.walk.floors.map(f => f.a), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let u = Math.ceil(U0 / 10) * 10; u <= U1; u += 10) el.push(`<line x1="${px(u, V0)[0]}" y1="0" x2="${px(u, V0)[0]}" y2="${H}" stroke="#eee"/><text x="${+px(u, V0)[0] + 2}" y="12" font-size="10" fill="#999">${u}</text>`);
    for (const f of res.walk.floors) { const P = []; for (let i = 0; i < f.poly.length; i += 2) P.push(toUV(f.poly[i], f.poly[i + 1])); if (P.every(([u]) => u < U0 || u > U1)) continue;
      const g = Math.round(200 - 110 * (f.a - y0) / Math.max(0.1, y1 - y0)); el.push(`<polygon points="${P.map(q => px(...q).join(',')).join(' ')}" fill="rgb(${g},${g},${g + 10})" fill-opacity="0.85"/>`); }
    const T = M.Track, PS = M.Stations.list.find(o => Math.hypot(o.x - SP.x, o.z - SP.z) < 400);
    if (PS) for (const p of PS.plats) { const L = [], R = []; for (let s = p.s0; s <= p.s1; s += 4) { const [li, lo] = M.Stations.platLat(p, s), a = T.point(s, li, {}), b = T.point(s, lo, {}); L.push(toUV(a.x, a.z)); R.push(toUV(b.x, b.z)); }
      el.push(`<polygon points="${[...L, ...R.reverse()].map(q => px(...q).join(',')).join(' ')}" fill="#3c6edc" fill-opacity="0.22" stroke="#2b5fd0"/>`); }
    if (PS) for (const dir of [0, 1]) { const P = []; for (let s = PS.sMin - 40; s <= PS.sMax + 40; s += 4) { const q = T.point(s, T.lane(s, dir), {}); P.push(toUV(q.x, q.z)); } el.push(`<polyline points="${P.map(q => px(...q).join(',')).join(' ')}" fill="none" stroke="#333" stroke-width="1.5" stroke-dasharray="6,3"/>`); }
    for (const t of pl.tracks) { const P = []; for (let u = U0; u <= U1; u += 2) { const S2 = M.MetroStations.spineAt(pl, u, {}), v = M.MetroStations.trackV(pl, t, u); P.push(toUV(S2.x + S2.rx * v, S2.z + S2.rz * v)); } el.push(`<polyline points="${P.map(q => px(...q).join(',')).join(' ')}" fill="none" stroke="#111" stroke-width="2"/>`); }
    for (const w of res.walk.walls) { const a = toUV(w.x0, w.z0), b = toUV(w.x1, w.z1); if ((a[0] < U0 && b[0] < U0) || (a[0] > U1 && b[0] > U1)) continue;
      el.push(`<line x1="${px(...a)[0]}" y1="${px(...a)[1]}" x2="${px(...b)[0]}" y2="${px(...b)[1]}" stroke="${w.tag === 'furn' ? '#e08a00' : '#d0202a'}" stroke-width="1.4"/>`); }
    writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="white"/>${el.join('')}</svg>`);
    console.log(out, W, 'x', H, 'floors', res.walk.floors.length, 'walls', res.walk.walls.length);
  } else if (cmd === 'peninsula') {
    const P = M.Stations, want = rest[0] ? rest[0].split(',') : [];
    for (const st of P.list) console.log(st.id, st.plats.map(p => p.side + (p.xplat ? '*' : '') + ' ' + p.s0.toFixed(1) + '-' + p.s1.toFixed(1) + ' w' + p.w.toFixed(2)).join(' | '), 'stop', st.stop.join(','), 'door', st.door.join(','));
    for (const id of want) { const st = P.list.find(o => o.id === id); if (!st) continue; const cam = { x: st.x, y: st.y + 2, z: st.z };
      for (let i = 0; i < 60 && !st.obj; i++) { P.update(1 / 30, cam, []); await new Promise(r => setTimeout(r, 5)); }
      let n = 0; if (st.obj) st.obj.traverse(o => { if (o.isMesh) n++; }); console.log('built', id, !!st.obj, 'meshes', n, 'triangles', st.obj ? tris(st.obj) : 0, 'boards', st.boards.length); }
  } else console.log('usage: node tools/metro_offline.mjs summary|ends|gaps|plan|eval|peninsula ... (see the header)');
}
