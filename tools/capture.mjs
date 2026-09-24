#!/usr/bin/env node
// Deterministic frame capture for trailers: headless Chrome on the real GPU, the page's own capture mode
// (__bayline.capture / stepFrame: a fixed time step, quality tiers frozen, an optional per-frame camera hook),
// one image per frame. Streaming keeps loading between frames, so a scene is warmed up in real time first.
//   node tools/capture.mjs --shot tools/trailer/shots/<name>.mjs --out <dir> [--w 1920 --h 1080 --dsf 2]
//        [--fps 30] [--fmt jpeg|png] [--quality 94] [--settle ms] [--base http://localhost:8123/lead.html]
// A shot module exports { hash, setup?, warm?, prime?, frames, fps?, settle?, before?, cam?, css? } (setup / before / cam are page-side
// function sources: setup runs once (may be async), before(t, dt) before each frame, cam(t, camera, dt) just
// before each render). The UI is hidden; the scene canvas, rain on the glass and lightning stay.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const shotPath = resolve(opt('shot')), out = resolve(opt('out'));
const shot = (await import(pathToFileURL(shotPath).href)).default;
const PREVIEW = +opt('preview', 0);                     // --preview K: step every frame, keep only K frames, at DSF 1
// shot.maxDsf caps the scale: headless 4K screenshots of the densest scenes (downtown at night, San Mateo) wedge the
// GPU readback, while 1.5x (2880x1620) is fine
const W = +opt('w', 1920), H = +opt('h', 1080), DSF = PREVIEW ? 1 : Math.min(+opt('dsf', 2), shot.maxDsf || 99), FPS = +opt('fps', shot.fps || 30);
const FMT = opt('fmt', 'jpeg'), QUAL = +opt('quality', 94), BASE = opt('base', 'http://localhost:8123/lead.html');
const SETTLE = +opt('settle', shot.settle || 0);          // ms per frame at most: wait for streaming to catch up before each shot
mkdirSync(out, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
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
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'log')) { const s = m.params.args.map(a => a.value ?? a.description ?? '').join(' '); if (!/not valid JSON/.test(s)) console.log(`[page.${m.params.type}]`, s.slice(0, 300)); }
  if (m.method === 'Runtime.exceptionThrown') console.log('[pageerror]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 600));
};
// every call times out (a wedged GPU process otherwise hangs a capture forever): fail loudly so the batch can retry
const send = (method, params = {}, ms = 120000) => new Promise((r, j) => { const i = ++id; const to = setTimeout(() => { pending.delete(i); j(new Error(`${method} timed out`)); }, ms);
  pending.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (code, what) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`${what}: ` + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
await send('Page.navigate', { url: BASE + (shot.hash || '#auto') });
const T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
await ev(`new Promise(r => { const f = () => window.__bayline && window.__bayline.capture && window.__bayline.Sim && window.__bayline.Sim.TT ? r(1) : setTimeout(f, 200); f(); })`, 'boot');
console.log(T(), 'booted');
// hide the interface (keep the scene, rain on the glass and lightning)
await ev(`(() => { const s = document.createElement('style'); s.textContent = 'body > *:not(#gl):not(#wdrops):not(#wflash) { visibility: hidden !important; } #gl { visibility: visible !important; } ${(shot.css || '').replace(/`/g, '')}'; document.head.appendChild(s); document.body.classList.add('photo'); return 1; })()`, 'css');
if (shot.setup) { const r = await ev(`(${shot.setup})()`, 'setup'); console.log(T(), 'setup', r ?? ''); }
// warm up in real time: tiles, trees, buildings stream around the camera (and until the queue drains, up to 3x)
const warm = shot.warm ?? 25;
await ev(`new Promise(r => { const B = window.__bayline, S = B.Stream, t0 = performance.now(); const f = () => { const busy = S && S.stats ? S.stats.active + S.stats.queued : 0, el = (performance.now() - t0) / 1000;
  if ((el > ${warm} && busy === 0) || el > ${warm * 3}) r(1); else setTimeout(f, 250); }; f(); })`, 'warm');
console.log(T(), 'warm');
if (shot.prime) { const r = await ev(`(${shot.prime})()`, 'prime'); console.log(T(), 'prime', r ?? ''); }
// capture
await ev(`(() => { const C = window.__bayline.capture; C.dt = 1 / ${FPS}; C.t = 0; C.before = ${shot.before || 'null'}; C.cam = ${shot.cam || 'null'}; C.on = true; return 1; })()`, 'hooks');
const N = +opt('frames', shot.frames || 90), ext = FMT === 'png' ? 'png' : 'jpg';
const keep = PREVIEW ? new Set(Array.from({ length: PREVIEW }, (_, k) => Math.round(k * (N - 1) / Math.max(1, PREVIEW - 1)))) : null;
for (let i = 0; i < N; i++) {
  await ev(`window.__bayline.stepFrame(${shot.substeps || 1}), 1`, 'step');
  if (keep && !keep.has(i)) continue;
  if (SETTLE) await ev(`window.__bayline.capture.settle(${SETTLE})`, 'settle');   // let tiles and builds catch up, redraw
  if (process.env.CAPDBG) console.log(i, await ev(`(() => { const r = window.__bayline.Env.renderer, gl = r.getContext(); return JSON.stringify({ lost: gl.isContextLost(), calls: r.info.render.calls, tris: r.info.render.triangles, err: gl.getError() }); })()`, 'dbg'));
  const shotR = await send('Page.captureScreenshot', FMT === 'png' ? { format: 'png' } : { format: 'jpeg', quality: QUAL });
  writeFileSync(join(out, `f${String(i).padStart(5, '0')}.${ext}`), Buffer.from(shotR.result.data, 'base64'));
  if (i % 30 === 0) console.log(T(), `frame ${i}/${N}`);
}
if (shot.after) { const r = await ev(`(${shot.after})()`, 'after'); console.log(T(), 'after', r ?? ''); }
console.log(T(), 'done', N, 'frames ->', out);
ws.close(); cleanup(); process.exit(0);
