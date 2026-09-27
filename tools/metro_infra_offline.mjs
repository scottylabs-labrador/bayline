#!/usr/bin/env node
// Metro guideway and tunnels without a browser or a GPU (infra workstream QA while the GPU is reserved). The real source
// files of the guideway stack (util, geo, data, the metro switch, MetroGround's carve, Track, MetroNet, MetroTrack,
// MetroGuide, MetroTube, and with --stations the stations stack for station limits and keep-outs) run in one Node vm
// scope as build.py concatenates them, with stubs for the DOM, the renderer and Under (a recorder). The terrain is the
// real L7 base (tiles/h, the same heights hBase reads), carved by MetroGround like the page carves it. Every chunk of
// every track is built to completion by MetroTrack's own jobs (the stepped generators run through).
//   node tools/metro_infra_offline.mjs hash [--layers body,detail,far] [--tracks ID,..] > OUT.jsonl
//        one line per chunk: layer, track, k, s0, s1, triangles, a hash of its geometry and one of its Under
//        registrations (cells, cuts, portals)
//        (--bins: also per mesh and 20 m of the chunk's track, so diff can say where a chunk changed)
//   node tools/metro_infra_offline.mjs diff A.jsonl B.jsonl   the chunks whose hashes differ, grouped into cases
//   node tools/metro_infra_offline.mjs clear [--tracks ID,..] [--hw 1.55] [--y0 0.6] [--y1 3.3] > OUT.json
//        clearance: every triangle of the body and detail layers against every track's train envelope (|lateral| < hw,
//        y0 .. y1 above the rail; the section through the triangle's nearest point on each track within reach)
//   node tools/metro_infra_offline.mjs cover [--tracks ID,..] > OUT.json
//        support: a face of the body layer (bed, deck, slab, floor) within 1.6 m under every track's centreline and rails,
//        every 4 m outside stations (holes), and faces laid twice at one place and height by two chunks (doubles)
//   node tools/metro_infra_offline.mjs eval FILE [ARGS_JSON]   a probe (async (B, args) => value) after the load
// Options: --js DIR (the sources from another tree, e.g. `git archive <rev> src/js | tar -x -C DIR`), --stations
// (load STATIONS' stack: MetroStations.limits and keepOut as in the page; slower), --metrodir metro-next/.
// Always run it through tools/wd.py; one process at a time (it holds a few GB while every chunk is built).
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (k) => { const i = args.indexOf('--' + k); if (i < 0) return false; args.splice(i, 1); return true; };
const JS = opt('js', join(ROOT, 'src/js')), LAYERS = opt('layers', 'body').split(','), ONLY = opt('tracks', null), METRODIR = opt('metrodir', null);
const HW = +opt('hw', '1.55'), Y0 = +opt('y0', '0.6'), Y1 = +opt('y1', '3.3'), STATIONS = flag('stations'), KEYS = opt('keys', null);
// (cover --rails: the detail layer's rail heads instead of the body's support: a face within 6 cm of the rail top at
// both rails, the centreline not asked)
const RAILS = flag('rails');
// (hash --bins: also a hash per mesh and 20 m of the chunk's track (each triangle by its centroid's nearest point on it),
// so diff can say where in a chunk and in which mesh the geometry changed)
const BINS = flag('bins'), BW = 20;
const [cmd, ...rest] = args;
const DATA = join(ROOT, 'data/pub/v2') + '/';
const inflate = (b) => (b.length > 2 && b[0] === 0x78 ? inflateSync(b) : b);

export async function load() {
  const read = (p) => inflate(readFileSync(DATA + p));
  const PROPS = new Set(['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign', 'textBaseline', 'globalAlpha', 'lineCap', 'lineJoin', 'filter', 'shadowBlur', 'shadowColor', 'globalCompositeOperation', 'imageSmoothingEnabled', 'letterSpacing']);
  const ctx2d = new Proxy({}, { get: (t, k) => k === 'measureText' ? (s) => ({ width: String(s).length * 10 })
    : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
    : k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern' ? () => ({ addColorStop() {} })
    : typeof k === 'string' && /^[a-z]/.test(k) && !PROPS.has(k) ? () => {} : undefined, set: () => true });
  const canvas = () => ({ width: 64, height: 64, style: {}, getContext: () => ctx2d, toDataURL: () => '', addEventListener() {} });
  // (the page's console.log goes to stderr: stdout carries only the results)
  const S = { console: Object.assign(Object.create(console), { log: (...a) => console.error(...a), info: (...a) => console.error(...a) }), setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, performance, TextDecoder, TextEncoder, URLSearchParams, Math, Date, JSON, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Error, Object, Array, Number, String, Boolean,
    Float32Array, Float64Array, Int8Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Uint8ClampedArray, ArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt, Infinity, NaN, structuredClone,
    atob: (s) => Buffer.from(s, 'base64').toString('binary') };
  S.window = S; S.self = S; S.globalThis = S;
  const hash = '#metro=1&mground=0' + (METRODIR ? '&metrodir=' + METRODIR : '');
  S.location = { hash, search: '', href: 'http://localhost/offline.html' + hash };
  S.navigator = { userAgent: 'node', hardwareConcurrency: 8 };
  S.document = { createElement: (k) => k === 'canvas' ? canvas() : { style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } },
    getElementById: () => null, body: { classList: { add() {}, remove() {} }, appendChild() {} }, addEventListener() {}, fonts: { load: async () => [] } };
  S.requestAnimationFrame = () => 0; S.addEventListener = () => {};
  vm.createContext(S);
  vm.runInContext(readFileSync(join(ROOT, 'vendor/three.min.js'), 'utf8'), S, { filename: 'three.min.js' });
  S.__read_json = (p) => JSON.parse(read(p).toString('utf8'));
  S.__read_bin = (p) => { const b = read(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
  S.__read_tile = (L, x, y) => { const p = DATA + `tiles/h/${L}/${x}_${y}.bin`; if (!existsSync(p)) return null; const b = inflate(readFileSync(p)); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
  vm.runInContext(`
    var Env = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: { capabilities: { getMaxAnisotropy: () => 1 } }, state: { exposure: 1 }, time: { sec: 43200, scale: 1 }, setClock(s) { this.time.sec = s; } };
    var Stream = { base: './data/v2/', json: async (p) => __read_json(p), bin: async (p) => __read_bin(p), stats: {} };
    // the L7 base (what hBase reads, and Terrain.h where no lidar tile is loaded), through the height filters (MetroGround)
    var Terrain = (() => {
      const X0 = -45056, Z0 = -49152, SIZE = 102400, HS = 129, filters = [], cache = new Map();
      const tileSize = (L) => SIZE / (1 << L);
      function decode(u8, qs = 16, qo = 200) {
        const n = HS * HS, res = new Uint16Array(u8.buffer, u8.byteOffset, n), q = new Int32Array(n), h = new Float32Array(n);
        for (let j = 0; j < HS; j++) for (let i = 0; i < HS; i++) {
          const k = j * HS + i, zz = res[k], r = (zz >>> 1) ^ -(zz & 1); let a, b, c;
          if (j === 0 && i === 0) { q[k] = r; continue; }
          if (j === 0) { a = q[k - 1]; b = a; c = a; } else if (i === 0) { b = q[k - HS]; a = b; c = b; } else { a = q[k - 1]; b = q[k - HS]; c = q[k - HS - 1]; }
          const mx = a > b ? a : b, mn = a < b ? a : b; q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
        }
        for (let k = 0; k < n; k++) h[k] = q[k] / qs - qo; return h;
      }
      const rawCache = new Map();
      function tile(L, x, y, raw) {
        const key = (L * 1024 + y + 256) * 1024 + x, C = raw ? rawCache : cache; if (C.has(key)) return C.get(key);
        const u8 = __read_tile(L, x, y); let H = null;
        if (u8 && u8.length >= HS * HS * 2) { H = decode(u8); const T = tileSize(L); if (!raw) for (const f of filters) f(L, X0 + x * T, Z0 + y * T, T, H); }
        C.set(key, H); return H;
      }
      function h(x, z, maxL = 7, raw = false) {
        for (let L = Math.min(7, maxL); L >= 0; L--) {
          const T = tileSize(L), tx = Math.floor((x - X0) / T), ty = Math.floor((z - Z0) / T), H = tile(L, tx, ty, raw); if (!H) continue;
          let fx = (x - X0 - tx * T) / T * 128, fz = (z - Z0 - ty * T) / T * 128;
          fx = fx < 0 ? 0 : fx > 127.999 ? 127.999 : fx; fz = fz < 0 ? 0 : fz > 127.999 ? 127.999 : fz;
          const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * HS + i;
          return Math.max(0, H[k] * (1 - u) * (1 - v) + H[k + 1] * u * (1 - v) + H[k + HS] * (1 - u) * v + H[k + HS + 1] * u * v);
        }
        return 0;
      }
      return { h, hBase: (x, z) => h(x, z, 7), hRaw: (x, z) => h(x, z, 7, true), tiled: true, hasDetail: () => true, ensure: async () => {}, isWater: () => false, update() {}, covers: () => true,
        addHeightFilter(fn) { filters.push(fn); cache.clear(); return Promise.resolve(); }, reloadHeights() {}, cutTest: null, cutUniforms: null, group: new THREE.Group(), stats: {} };
    })();
    // Under: a recorder (every registration kept by id, and a log in order, so each chunk's own can be read back)
    var Under = (() => {
      const cells = new Map(), cuts = new Map(), portals = new Map(), log = [];
      const api = { enabled: true, state: { cell: null }, stats: { cells: 0, cuts: 0, portals: 0 }, cells, cuts, portals, log, debug: {},
        addCell(o) { cells.set(o.id, o); log.push(['cell', o.id, o]); }, addCut(o) { cuts.set(o.id, o); log.push(['cut', o.id, o]); }, addPortal(o) { portals.set(o.id, o); log.push(['portal', o.id, o]); },
        remove(id) { return cells.delete(id) || cuts.delete(id) || portals.delete(id); }, keep(o) { return o; }, outdoor() {}, cutAt: () => false, cellAt: () => null, dayAt: () => 1,
        update() {}, preRender() {}, postRender() {} };
      return api;
    })();`, S);
  const files = ['00_util.js', '01_geo.js', '02_data.js', '18_metro.js', '19_metroground.js', '20_track.js', '21_metronet.js', '23_metrotrack.js', '24_metroguide.js', '24_metrotube.js']
    .concat(STATIONS ? ['25_stations.js', '26_metrostations.js', '27_stationkit.js', '27_stationparts.js', '27_stationsigns.js', '27_stationtypes.js', '28_stationheroes.js'] : []);
  let src = files.map(f => `// ===== ${f} =====\n` + readFileSync(join(JS, f), 'utf8')).join('\n');
  // (QA entry points: MetroTrack's chunk jobs, run to completion here; the page never needs them)
  src = src.replace('return { enabled: true, init, update,', 'return { __qa: { bodyJob, detailJob, farJob, disposeChunk }, enabled: true, init, update,');
  if (STATIONS) src = src.replace('if (envInterior) return envInterior;', 'if (envInterior) return envInterior; if (!renderer) return null;');
  vm.runInContext(`(function(){'use strict';\n${src}\nglobalThis.__M = { U, Geo, Metro, Track, MetroNet, MetroGround, MetroTrack, MetroGuide, MetroTube${STATIONS ? ', Stations, MetroStations' : ''} };\n})();`, S, { filename: 'infra-stack.js' });
  const M = S.__M;
  if (M.Metro.start) M.Metro.start();
  await M.MetroNet.load();
  if (STATIONS) { await M.Track.load(); M.Stations.init(); await M.MetroStations.init(); }
  M.MetroGround.install();
  await M.MetroTrack.init();
  if (!M.MetroTrack.ready) throw new Error('MetroTrack did not start');
  return { M, S };
}

// FNV-1a over quantised values (mm for positions, 1e-3 for the rest)
function hasher() { let h = 2166136261; return { mix(v) { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619); }, str(s) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } }, get v() { return (h >>> 0).toString(16).padStart(8, '0'); } }; }
function hashGroup(g) {
  const H = hasher(); let tris = 0;
  if (g) g.traverse(o => { if (!o.isMesh || !o.geometry) return; const G = o.geometry; H.str(o.name || ''); H.mix(o.renderOrder || 0);
    for (const name of Object.keys(G.attributes).sort()) { H.str(name); const a = G.attributes[name].array; for (let i = 0; i < a.length; i++) H.mix(a[i]); }
    if (G.index) { const a = G.index.array; for (let i = 0; i < a.length; i++) H.mix(a[i]); tris += a.length / 3; } else if (G.attributes.position) tris += G.attributes.position.count / 3; });
  return { geo: H.v, tris: Math.round(tris) };
}
// per material and 20 m of the nearest track (each triangle by its centroid): [sum of the triangles' hashes, count]
// (order-free: triangles that only moved within a buffer hash the same). A partner's rails, built by the primary's
// chunk, are found on the partner's own s.
function binHashes(M, ch, g) {
  const MT = M.MetroTrack, NET = M.MetroNet, bins = {}, cache = new Map(), mats = new Map(Object.entries(MT.MATS || {}).map(([k, v]) => [v, k]));
  const near = (x, z) => { const k = Math.floor(x / 2) * 1000003 + Math.floor(z / 2); let r = cache.get(k); if (r !== undefined) return r;
    const o = NET.nearest(x, z, 60); r = o ? (MT.trackOf(o.track) || { id: '?' }).id + '@' + Math.floor(o.s / BW) : 'x'; cache.set(k, r); return r; };
  if (!g) return bins; g.updateMatrixWorld(true);
  g.traverse(o => { if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const A = o.geometry.attributes.position.array, I = o.geometry.index ? o.geometry.index.array : null, C = o.geometry.attributes.color ? o.geometry.attributes.color.array : null, me = o.matrixWorld.elements;
    const nm = (Array.isArray(o.material) ? 'multi' : mats.get(o.material)) || o.name || 'mesh', nt = I ? I.length / 3 : A.length / 9;
    for (let t = 0; t < nt; t++) { let h = 2166136261, cx = 0, cz = 0;
      for (let c = 0; c < 3; c++) { const vi = I ? I[t * 3 + c] : t * 3 + c; const x = A[vi * 3], y = A[vi * 3 + 1], z = A[vi * 3 + 2];
        const wx = me[0] * x + me[4] * y + me[8] * z + me[12], wy = me[1] * x + me[5] * y + me[9] * z + me[13], wz = me[2] * x + me[6] * y + me[10] * z + me[14];
        cx += wx / 3; cz += wz / 3; h ^= Math.round(wx * 1000) | 0; h = Math.imul(h, 16777619); h ^= Math.round(wy * 1000) | 0; h = Math.imul(h, 16777619); h ^= Math.round(wz * 1000) | 0; h = Math.imul(h, 16777619);
        if (C) for (let q = 0; q < 3; q++) { h ^= Math.round(C[vi * 3 + q] * 1000) | 0; h = Math.imul(h, 16777619); } }
      const key = nm + '@' + near(cx, cz), e = bins[key] || (bins[key] = [0, 0]); e[0] = (e[0] + (h >>> 0)) >>> 0; e[1]++; } });
  const out = {}; for (const k of Object.keys(bins).sort()) out[k] = bins[k][0].toString(16) + ':' + bins[k][1]; return out;
}
function hashValue(H, v) {
  if (v === null || v === undefined) { H.str('~'); return; }
  if (typeof v === 'number') { H.mix(v); return; } if (typeof v === 'string') { H.str(v); return; } if (typeof v === 'boolean') { H.mix(v ? 1 : 0); return; }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) { H.str('['); for (const x of v) hashValue(H, x); H.str(']'); return; }
  if (v.isObject3D || v.isMesh) { H.str('obj'); return; }
  if (v.isVector3) { H.mix(v.x); H.mix(v.y); H.mix(v.z); return; }
  if (typeof v === 'object') { for (const k of Object.keys(v).sort()) { if (k === 'group' || k === 'mesh') continue; H.str(k); hashValue(H, v[k]); } }
}
// one chunk built by its layer's job (to completion), hashed, then disposed (with its Under registrations)
function buildChunk(M, ch) {
  const MT = M.MetroTrack, qa = MT.__qa, U0 = globalUnder(M).log.length;
  const job = ch.layer === 'body' ? qa.bodyJob(ch) : ch.layer === 'detail' ? qa.detailJob(ch) : qa.farJob(ch);
  let r = job.next(), steps = 0; while (!r.done) { r = job.next(); steps++; }
  const reg = globalUnder(M).log.slice(U0);
  return { g: ch.g, reg, steps };
}
let _under = null; const globalUnder = (M) => _under;

export async function run() {
  const { M, S } = await load(); _under = S.Under;
  const MT = M.MetroTrack, T = MT.TRACKS.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const only = ONLY ? new Set(ONLY.split(',')) : null;
  return { M, S, MT, T: only ? T.filter(R => only.has(R.id)) : T };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'hash') {
    const { M, MT, T } = await run(); const t0 = Date.now(); let n = 0, bad = 0;
    for (const layer of LAYERS) for (const R of T) for (const ch of R.L[layer]) {
      let line;
      try {
        const { g, reg } = buildChunk(M, ch); const h = hashGroup(g); const HU = hasher();
        for (const [kind, id, o] of reg) { HU.str(kind); HU.str(id); hashValue(HU, o); }
        line = { layer, id: R.id, k: ch.k, s0: +ch.s0.toFixed(1), s1: +ch.s1.toFixed(1), tris: h.tris, geo: h.geo, under: HU.v, reg: reg.length };
        if (BINS) line.bins = binHashes(M, ch, g);
      } catch (e) { bad++; line = { layer, id: R.id, k: ch.k, s0: +ch.s0.toFixed(1), s1: +ch.s1.toFixed(1), error: String(e && e.stack || e).split('\n').slice(0, 4).join(' | ') }; }
      try { MT.__qa.disposeChunk(ch); } catch (e) {}
      console.log(JSON.stringify(line)); n++;
    }
    console.error('chunks', n, 'errors', bad, 'ms', Date.now() - t0);
    process.exit(0);
  } else if (cmd === 'diff') {
    const rd = (f) => { const m = new Map(); for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l.startsWith('{')) continue; const o = JSON.parse(l); m.set(o.layer + ':' + o.id + ':' + o.k, o); } return m; };
    const A = rd(rest[0]), B = rd(rest[1]); const ch = [];
    for (const [k, a] of A) { const b = B.get(k); if (!b) { ch.push({ k, a, b: null, why: 'missing in B' }); continue; } const why = [];
      if (a.error || b.error) why.push('error'); if (a.geo !== b.geo) why.push('geometry'); if (a.under !== b.under) why.push('under'); if (why.length) ch.push({ k, a, b, why: why.join('+') }); }
    for (const [k, b] of B) if (!A.has(k)) ch.push({ k, a: null, b, why: 'missing in A' });
    // cases: runs of consecutive changed chunks per layer and track
    const byT = new Map(); for (const c of ch) { const o = c.a || c.b, key = o.layer + ' ' + o.id; if (!byT.has(key)) byT.set(key, []); byT.get(key).push(c); }
    console.log('chunks A', A.size, 'B', B.size, 'changed', ch.length, 'unchanged', A.size - ch.filter(c => c.a).length);
    for (const [key, list] of [...byT].sort()) { list.sort((x, y) => (x.a || x.b).k - (y.a || y.b).k); const runs = []; let cur = null;
      for (const c of list) { const o = c.a || c.b; if (cur && o.k === cur.k1 + 1) { cur.k1 = o.k; cur.s1 = o.s1; cur.why.add(c.why); cur.dt += ((c.b && c.b.tris) || 0) - ((c.a && c.a.tris) || 0); } else { cur = { k0: o.k, k1: o.k, s0: o.s0, s1: o.s1, why: new Set([c.why]), dt: ((c.b && c.b.tris) || 0) - ((c.a && c.a.tris) || 0) }; runs.push(cur); } }
      console.log(key.padEnd(18), runs.map(r => `${r.s0.toFixed(0)}-${r.s1.toFixed(0)} (${[...r.why].join(',')}; tris ${r.dt >= 0 ? '+' : ''}${r.dt})`).join('  ')); }
    // (with --bins hashes on both sides: where each changed chunk changed, per material, as s ranges of the nearest
    // track, 20 m steps; the chunk that built it in brackets when it is another track's)
    if (ch.some(c => c.a && c.b && c.a.bins && c.b.bins)) {
      console.log('\nwhere (material: nearest track s ranges, 20 m steps; [chunks that built it]):');
      const all = new Map();                                       // track id -> material -> Map(bin -> Set of 'layer:chunk track')
      for (const c of ch) { if (!c.a || !c.b || !c.a.bins || !c.b.bins || c.a.geo === c.b.geo) continue;
        for (const k of new Set([...Object.keys(c.a.bins), ...Object.keys(c.b.bins)])) { if (c.a.bins[k] === c.b.bins[k]) continue; const [nm, tid, bn] = k.split('@'); const T = tid === 'x' ? '(none)' : tid;
          if (!all.has(T)) all.set(T, new Map()); const Mm = all.get(T); if (!Mm.has(nm)) Mm.set(nm, new Map()); const B2 = Mm.get(nm), bi = bn === undefined ? -1 : +bn;
          if (!B2.has(bi)) B2.set(bi, new Set()); B2.get(bi).add(c.a.layer + (c.a.id === T ? '' : ':' + c.a.id)); } }
      for (const [tid, Mm] of [...all].sort()) { const parts = [];
        for (const [nm, B2] of [...Mm].sort()) { const bs = [...B2.keys()].sort((x, y) => x - y), rs = []; let cur = null;
          for (const b of bs) { const by = [...B2.get(b)].sort().join(','); if (cur && b === cur[1] + 1) { cur[1] = b; by.split(',').forEach(x => cur[2].add(x)); } else { cur = [b, b, new Set(by.split(','))]; rs.push(cur); } }
          parts.push(nm + ' ' + rs.map(r => (r[0] < 0 ? '?' : (r[0] * BW) + '-' + ((r[1] + 1) * BW)) + ' [' + [...r[2]].join(',') + ']').join(', ')); }
        console.log(tid.padEnd(12), parts.join('; ')); }
    }
    process.exit(0);
  } else if (cmd === 'clear') {
    const { M, S, MT, T } = await run(); const NET = M.MetroNet, t0 = Date.now(); const F = {}, clashes = []; let tri = 0;
    const byTrack = new Map();
    const rect = { x0: -HW, x1: HW, y0: Y0, y1: Y1 };
    // 2D triangle (in the section plane: lateral, up) against the envelope rectangle (separating axes)
    const overlap = (P) => {
      const xs = [P[0], P[2], P[4]], ys = [P[1], P[3], P[5]];
      if (Math.max(...xs) <= rect.x0 || Math.min(...xs) >= rect.x1 || Math.max(...ys) <= rect.y0 || Math.min(...ys) >= rect.y1) return false;
      const C = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]];
      for (let e = 0; e < 3; e++) { const ax = P[e * 2], ay = P[e * 2 + 1], bx = P[((e + 1) % 3) * 2], by = P[((e + 1) % 3) * 2 + 1]; let nx = -(by - ay), ny = bx - ax; const L = Math.hypot(nx, ny); if (L < 1e-6) continue; nx /= L; ny /= L;
        let tmin = 1e9, tmax = -1e9; for (let k = 0; k < 3; k++) { const d = P[k * 2] * nx + P[k * 2 + 1] * ny; tmin = Math.min(tmin, d); tmax = Math.max(tmax, d); }
        let rmin = 1e9, rmax = -1e9; for (const [cx, cy] of C) { const d = cx * nx + cy * ny; rmin = Math.min(rmin, d); rmax = Math.max(rmax, d); }
        if (tmax <= rmin + 1e-4 || rmax <= tmin + 1e-4) return false; }
      return true;
    };
    const v = new S.THREE.Vector3();
    // (--keys FILE: only these chunks, one 'layer:track:k' a line, e.g. the ones a diff lists)
    const keys = KEYS ? new Set(readFileSync(KEYS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)) : null;
    for (const layer of keys ? ['body', 'detail'] : LAYERS) for (const R of (keys ? MT.TRACKS : T)) for (const ch of R.L[layer]) {
      if (keys && !keys.has(layer + ':' + R.id + ':' + ch.k)) continue;
      let g; try { g = buildChunk(M, ch).g; } catch (e) { console.error('build', layer, R.id, ch.k, String(e)); continue; }
      if (g) { g.updateMatrixWorld(true); g.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return; const P = o.geometry.attributes.position.array, I = o.geometry.index ? o.geometry.index.array : null, me = o.matrixWorld.elements;
        const nt = I ? I.length / 3 : P.length / 9; const W = new Float64Array(9), L2 = new Float64Array(6);
        for (let t = 0; t < nt; t++) { tri++;
          for (let c = 0; c < 3; c++) { const vi = I ? I[t * 3 + c] : t * 3 + c; const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];
            W[c * 3] = me[0] * x + me[4] * y + me[8] * z + me[12]; W[c * 3 + 1] = me[1] * x + me[5] * y + me[9] * z + me[13]; W[c * 3 + 2] = me[2] * x + me[6] * y + me[10] * z + me[14]; }
          const cx = (W[0] + W[3] + W[6]) / 3, cz = (W[2] + W[5] + W[8]) / 3; let rr = 0; for (let c = 0; c < 3; c++) rr = Math.max(rr, Math.hypot(W[c * 3] - cx, W[c * 3 + 2] - cz));
          if (rr > 40) continue;                                   // (nothing that big is a wall beside a track)
          const ymin = Math.min(W[1], W[4], W[7]), ymax = Math.max(W[1], W[4], W[7]);
          for (const q of NET.nearAll(cx, cz, rr + HW + 0.5)) {
            const Q = MT.trackOf(q.track); if (!Q) continue; MT.frameAt(Q, q.s, F);
            if (ymax - F.y <= Y0 || ymin - F.y >= Y1 + 0.5) continue;                 // (nowhere near the envelope's height)
            let far = false;
            for (let c = 0; c < 3; c++) { const dx = W[c * 3] - F.x, dz = W[c * 3 + 2] - F.z, al = dx * F.tx + dz * F.tz; if (Math.abs(al) > 12) far = true; L2[c * 2] = dx * F.lx + dz * F.lz; L2[c * 2 + 1] = W[c * 3 + 1] - F.y; }
            if (far || !overlap(L2)) continue;
            const key = Q.id; if (!byTrack.has(key)) byTrack.set(key, []);
            byTrack.get(key).push([+q.s.toFixed(1), layer, R.id, ch.k, +Math.min(Math.abs(L2[0]), Math.abs(L2[2]), Math.abs(L2[4])).toFixed(2), o.material === MT.MATS.fence ? 'fence' : o.material === MT.MATS.tunnel ? 'tunnel' : 'infra']);
          }
        } }); }
      try { MT.__qa.disposeChunk(ch); } catch (e) {}
    }
    // runs of clashes per track (s within 6 m of each other)
    const out = {}; for (const [id, list] of byTrack) { list.sort((a, b) => a[0] - b[0]); const runs = []; let cur = null;
      for (const c of list) { const by = c[1] + ':' + c[2] + ':' + c[3] + ':' + c[5]; if (cur && c[0] - cur.s1 <= 6) { cur.s1 = c[0]; cur.n++; cur.by.add(by); cur.minLat = Math.min(cur.minLat, c[4]); } else { cur = { s0: c[0], s1: c[0], n: 1, by: new Set([by]), minLat: c[4] }; runs.push(cur); } }
      out[id] = runs.map(r => ({ s0: r.s0, s1: r.s1, n: r.n, minLat: r.minLat, by: [...r.by].slice(0, 6) })); }
    console.log(JSON.stringify({ envelope: { hw: HW, y0: Y0, y1: Y1 }, triangles: tri, ms: Date.now() - t0, clashes: out }, null, 1));
    process.exit(0);
  } else if (cmd === 'cover') {
    // support under every track: the body layer's upward faces (bed, deck, slab, floor) in a 4 m grid, then every track
    // every 4 m (outside stations): a face under its centreline and both rails within 1.6 m below the rail top? Also
    // where two chunks lay a face at the same place and height (a structure built twice). Paired with a second tree's
    // output, only what differs matters.
    const { M, S, MT, T } = await run(); const t0 = Date.now(); const CELLG = 4, grid = new Map(); let nTri = 0;
    // (upward faces within 4.5 m of a track only, in a growable Float32Array, 9 per face, and a chunk tag each)
    let PW = new Float32Array(9 * 1 << 20), PT = new Int32Array(1 << 20); const tags = [];
    const push = (W, tagI) => { if (nTri >= PT.length) { const a = new Float32Array(PW.length * 2); a.set(PW); PW = a; const b = new Int32Array(PT.length * 2); b.set(PT); PT = b; } PW.set(W, nTri * 9); PT[nTri] = tagI; return nTri++; };
    const P = { W: (id) => PW.subarray(id * 9, id * 9 + 9), tag: (id) => tags[PT[id]] };
    for (const R of MT.TRACKS) for (const ch of R.L[RAILS ? 'detail' : 'body']) {
      let g; try { g = buildChunk(M, ch).g; } catch (e) { console.error('build', R.id, ch.k, String(e)); continue; }
      const tagI = tags.push(R.id + ':' + ch.k) - 1;
      if (g) { g.updateMatrixWorld(true); g.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return; const A = o.geometry.attributes.position.array, I = o.geometry.index ? o.geometry.index.array : null, me = o.matrixWorld.elements;
        const nt = I ? I.length / 3 : A.length / 9;
        for (let t = 0; t < nt; t++) {
          const W = new Float64Array(9);
          for (let c = 0; c < 3; c++) { const vi = I ? I[t * 3 + c] : t * 3 + c; const x = A[vi * 3], y = A[vi * 3 + 1], z = A[vi * 3 + 2];
            W[c * 3] = me[0] * x + me[4] * y + me[8] * z + me[12]; W[c * 3 + 1] = me[1] * x + me[5] * y + me[9] * z + me[13]; W[c * 3 + 2] = me[2] * x + me[6] * y + me[10] * z + me[14]; }
          const ux = W[3] - W[0], uy = W[4] - W[1], uz = W[5] - W[2], vx = W[6] - W[0], vy = W[7] - W[1], vz = W[8] - W[2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz); if (nl < 1e-8 || Math.abs(ny) / nl < 0.6) continue;
          const x0 = Math.min(W[0], W[3], W[6]), x1 = Math.max(W[0], W[3], W[6]), z0 = Math.min(W[2], W[5], W[8]), z1 = Math.max(W[2], W[5], W[8]);
          if (x1 - x0 > 60 || z1 - z0 > 60) continue;
          if (!M.MetroNet.nearAll((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 4.5).length) continue;
          const id = push(W, tagI);
          for (let i = Math.floor(x0 / CELLG); i <= Math.floor(x1 / CELLG); i++) for (let j = Math.floor(z0 / CELLG); j <= Math.floor(z1 / CELLG); j++) { const k = i * 100003 + j; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(id); }
        } }); }
      try { MT.__qa.disposeChunk(ch); } catch (e) {}
    }
    // (point in the triangle's xz projection: its height there)
    const hAt = (W, x, z) => { const ax = W[0], az = W[2], bx = W[3], bz = W[5], cx = W[6], cz = W[8]; const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) return null;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2; if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) return null; return l1 * W[1] + l2 * W[4] + l3 * W[7]; };
    const F = {}, holes = {}, doubles = {};
    for (const R of T) { if (R.cls === 'crossover') continue;
      for (let s = 2; s < R.len - 2; s += 4) { if (MT.inStation(R, s, 2)) continue; MT.frameAt(R, s, F);
        let miss = 0; const dup = new Set();
        for (const lat of RAILS ? [-R.railC, R.railC] : [0, -R.railC, R.railC]) { const x = F.x + F.rx * lat, z = F.z + F.rz * lat, y = F.y + F.ry * lat; const l = grid.get(Math.floor(x / CELLG) * 100003 + Math.floor(z / CELLG)) || [];
          let hit = false; const hs = []; for (const id of l) { const h = hAt(P.W(id), x, z); if (h === null) continue; if (RAILS ? (h > y - 0.06 && h < y + 0.03) : (h > y - 1.6 && h < y + 0.05)) { hit = true; hs.push([h, P.tag(id)]); } }
          if (!hit) miss++;
          hs.sort((a, b) => a[0] - b[0]); for (let i = 1; i < hs.length; i++) if (Math.abs(hs[i][0] - hs[i - 1][0]) < 0.03 && hs[i][1] !== hs[i - 1][1]) dup.add(hs[i - 1][1] + '|' + hs[i][1]); }
        if (miss) (holes[R.id] || (holes[R.id] = [])).push(s);
        if (dup.size) (doubles[R.id] || (doubles[R.id] = [])).push([s, [...dup][0]]); } }
    const runs = (list) => { const out = []; let cur = null; for (const s of list) { if (cur && s - cur[1] <= 8) cur[1] = s; else { cur = [s, s]; out.push(cur); } } return out.map(r => r[0] + '-' + r[1]); };
    const out = { tris: nTri, ms: Date.now() - t0, holes: {}, doubles: {} };
    for (const [id, l] of Object.entries(holes)) out.holes[id] = runs(l);
    for (const [id, l] of Object.entries(doubles)) { const r = runs(l.map(x => x[0])); out.doubles[id] = r.map((q, i) => q + ' ' + (l.find(x => x[0] >= +q.split('-')[0]) || [0, ''])[1]); }
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
  } else if (cmd === 'eval') {
    const { M, S, MT, T } = await run();
    const B = Object.assign({ THREE: S.THREE, Terrain: S.Terrain, Under: S.Under, build: (ch) => buildChunk(M, ch), dispose: (ch) => MT.__qa.disposeChunk(ch), hashGroup, tracks: T }, M);
    const f = vm.runInContext('(' + readFileSync(resolve(rest[0]), 'utf8') + ')', S);
    console.log(JSON.stringify(await f(B, JSON.parse(rest[1] || '{}'))));
    process.exit(0);
  } else { console.log('usage: node tools/metro_infra_offline.mjs hash|diff|clear|eval ... (see the header)'); process.exit(1); }
}
