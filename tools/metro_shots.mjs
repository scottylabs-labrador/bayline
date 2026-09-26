#!/usr/bin/env node
// Many station views from ONE page load (stations workstream QA). Headless Chrome on the real GPU over the DevTools
// protocol (no dependencies, Node 22+), like tools/shot.mjs, but the page is loaded once and every view is staged with
// MetroStations.shot() (capture-mode camera at station coordinates, waits for the build and the exposure) and captured.
//   node tools/metro_shots.mjs --views views.json --out DIR [--base http://localhost:8135/stations.html] [--w 1600 --h 900]
//        [--fmt jpeg|png] [--quality 88] [--hash "q=high"] [--allconsole] [--mobile]
// views.json: [{ "name": "embr_plat", "id": "EMBR", "t": "17:30", "opts": { "u": -40, "v": 0, "h": 1.65, "yaw": 0.2, "fov": 70 } }, ...]
//   or { "name", "eval": "<expression>" } / { "name", "evalFile": "tools/metro_keepout_map.js", "args": {...} }: evaluated in the
//   page (B = window.__bayline), the value printed (a PNG data URL, or { png }, is saved as <out>/<name>.png)
//   or { "name", "wait": 20000 }: the page's own camera after that long (use it first, with --hash "mst=WOAK" etc.)
// Always run it through tools/wd.py (kills a hung Chrome).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const views = JSON.parse(readFileSync(resolve(opt('views')), 'utf8'));
const out = resolve(opt('out', '.')); mkdirSync(out, { recursive: true });
const W = +opt('w', 1600), H = +opt('h', 900), FMT = opt('fmt', 'jpeg'), QUAL = +opt('quality', 88);
const first = views[0];
const base = opt('base', 'http://localhost:8135/stations.html');
const hashExtra = opt('hash', '');
const ALLCON = args.includes('--allconsole');            // print every console error / warning (clean-console tours)
const MOBILE = args.includes('--mobile');                // phone profile: DPR 2, touch, mobile UA (Low tier by default)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(tmpdir(), 'mshots-'));
// (--gc: expose window.gc() for exact heap measurements)
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', ...(args.includes('--gc') ? ['--js-flags=--expose-gc'] : []),
  '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let cleaned = false;
function cleanup() { if (cleaned) return; cleaned = true; try { chrome.kill('SIGKILL'); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(3); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(3); });
let wsUrl = null; const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 20000) {
  const f = join(prof, 'DevToolsActivePort');
  if (existsSync(f)) { const [port] = readFileSync(f, 'utf8').split('\n');
    if (+port > 0) try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const pg = list.find(t => t.type === 'page'); if (pg) wsUrl = pg.webSocketDebuggerUrl; } catch {} }
  if (!wsUrl) await new Promise(r => setTimeout(r, 100));
}
if (!wsUrl) { console.error('chrome did not start'); process.exit(2); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) { const s = m.params.args.map(a => a.value ?? a.description ?? '').join(' '); if (ALLCON || /metro|station|Station|Metro|TypeError|ReferenceError/.test(s)) console.log('[console.' + m.params.type + ']', s.slice(0, 500)); }
  if (m.method === 'Runtime.exceptionThrown') console.log('[pageerror]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 800));
};
const send = (method, params = {}, ms = 180000) => new Promise((r, j) => { const i = ++id; const to = setTimeout(() => { pending.delete(i); j(new Error(`${method} timed out`)); }, ms);
  pending.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (code, ms) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }, ms);
  if (r.result?.exceptionDetails) { console.log('[eval error]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return null; } return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: MOBILE ? 2 : 1, mobile: MOBILE });
if (MOBILE) { await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' }); }
// start near the first view's station so its surroundings stream first
const ll = await (async () => { try { const j = JSON.parse(readFileSync(resolve('data/pub/v2/metro/network.json'), 'utf8')); const s = j.stations.find(x => x.id === first.id); return s ? `${s.lat.toFixed(5)},${s.lon.toFixed(5)},150,0.8,-0.4` : ''; } catch { return ''; } })();
// (--rawhash: the hash exactly as given, e.g. "auto&t=09:10&at=millbrae&metro=0")
const RAW = opt('rawhash', null);
const url = RAW ? `${base}#${RAW}` : `${base}#auto&metro=1&t=${first.t || '17:30'}${ll ? '&ll=' + ll : ''}${hashExtra ? '&' + hashExtra : ''}`;
await send('Page.navigate', { url });
// (--ready world: wait for the world instead of the metro stations, for #metro=0 comparisons)
const READY = opt('ready', 'metro') === 'world' ? 'B && B.World && B.World.started' : 'B && B.MetroStations && B.MetroStations.ready';
const ready = await ev(`new Promise(r => { const t0 = Date.now(); const iv = setInterval(() => { const B = window.__bayline; if (${READY}) { clearInterval(iv); r(true); } if (Date.now() - t0 > 90000) { clearInterval(iv); r(false); } }, 300); })`, 120000);
if (!ready) { console.error('page not ready'); cleanup(); process.exit(4); }
const results = [];
for (const v of views) {
  const t1 = Date.now();
  // { name, eval: "<expression or async IIFE>" }: evaluate in the page and print the value (no screenshot)
  // { name, evalFile: "tools/x.js", args: {...} }: the file holds one async arrow function (B, args) => value
  if (v.evalFile) v.eval = `(${readFileSync(resolve(v.evalFile), 'utf8')})(B, ${JSON.stringify(v.args || {})})`;
  // (a value that is a PNG data URL is written to <out>/<name>.png instead)
  if (v.eval) { let val = await ev(`(async () => { const B = window.__bayline; return await (${v.eval}); })()`, 900000);
    if (typeof val === 'string' && val.startsWith('data:image/png;base64,')) { const f = join(out, `${v.name}.png`); writeFileSync(f, Buffer.from(val.slice(22), 'base64')); val = f; }
    else if (val && typeof val === 'object' && typeof val.png === 'string') { const f = join(out, `${v.name}.png`); writeFileSync(f, Buffer.from(val.png.slice(22), 'base64')); val.png = f; }
    console.log(JSON.stringify({ name: v.name, ms: Date.now() - t1, value: val })); results.push({ name: v.name, value: val }); continue; }
  // { name, wait: ms }: the page's own camera (e.g. after a #mst= link), captured after ms of free running
  if (v.wait) { await ev(`new Promise(r => setTimeout(() => r(true), ${+v.wait}))`, +v.wait + 60000);
    const pos = await ev(`(() => { const c = window.__bayline.Env.camera.position; return [c.x, c.y, c.z].map(x => +x.toFixed(1)); })()`, 10000);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: QUAL }); const file = join(out, `${v.name}.jpg`); writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(JSON.stringify({ name: v.name, ms: Date.now() - t1, cam: pos })); results.push({ name: v.name, file }); continue; }
  const clock = v.t ? `{ const [h, m] = '${v.t}'.split(':').map(Number); window.__bayline.Env.setClock(h * 3600 + m * 60); }` : '';
  const res = await ev(`(async () => { ${clock} return await window.__bayline.MetroStations.shot(${JSON.stringify(v.id)}, ${JSON.stringify(v.opts || {})}); })()`, 900000);
  const shot = await send('Page.captureScreenshot', FMT === 'png' ? { format: 'png' } : { format: 'jpeg', quality: QUAL });
  const file = join(out, `${v.name}.${FMT === 'png' ? 'png' : 'jpg'}`);
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  const info = res && res.info ? res.info : null;
  console.log(JSON.stringify({ name: v.name, ms: Date.now() - t1, state: res && res.state, tris: res && res.tris, calls: res && res.post && res.post.calls, mode: info && info.mode, perf: res && res.perf ? { dCalls: res.perf.dCalls, dTris: res.perf.dTris, gpuOn: res.perf.on.gpu, gpuOff: res.perf.off.gpu, pct: res.perf.pct } : undefined }));
  results.push({ name: v.name, file, res });
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
ws.close(); cleanup(); process.exit(0);
