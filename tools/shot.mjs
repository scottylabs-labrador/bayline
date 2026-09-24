#!/usr/bin/env node
// Headless Chrome screenshot over the DevTools protocol (no dependencies, Node 22+).
//   node tools/shot.mjs <page.html|url> <out.png> [--w 1400] [--h 900] [--wait 4000]
//        [--eval "js to run after load, may return a promise"] [--eval2 "js to run just before the shot"]
//        [--gpu]  (use the real GPU instead of SwiftShader; faster, needs a display session)  [--mobile] (phone: touch, DPR 2)
// Prints console messages and page errors. Exit code 1 if the page threw.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const [page, out] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--gpu', '--mobile'].includes(args[i - 1])));
const W = +opt('w', 1400), H = +opt('h', 900), WAIT = +opt('wait', 4000);
const url = /^https?:|^file:/.test(page) ? page : pathToFileURL(resolve(page)).href;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(tmpdir(), 'shot-'));
const gl = flag('gpu') ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run',
  '--no-default-browser-check', '--ignore-gpu-blocklist', '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, ...gl, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
// never leave Chrome (or its profile, often hundreds of MB) behind: normal exit, errors, Ctrl-C or a watchdog's kill
let cleaned = false;
function cleanup() { if (cleaned) return; cleaned = true; try { chrome.kill('SIGKILL'); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(3); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(3); });
let wsUrl = null;
const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 20000) {
  const f = join(prof, 'DevToolsActivePort');
  if (existsSync(f)) { const [port] = readFileSync(f, 'utf8').split('\n');     // (the file can exist before the port is written)
    if (+port > 0) try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pg = list.find(t => t.type === 'page'); if (pg) wsUrl = pg.webSocketDebuggerUrl; } catch {} }
  if (!wsUrl) await new Promise(r => setTimeout(r, 100));
}
if (!wsUrl) { console.error('chrome did not start'); process.exit(2); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); let threw = false;
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') console.log(`[console.${m.params.type}]`, m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 600));
  if (m.method === 'Runtime.exceptionThrown') { threw = true; console.log('[pageerror]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 1200)); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
const mobile = flag('mobile');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
if (mobile) { await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }); }
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, 1500));
const ev = async code => { if (!code) return; const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value; if (v !== undefined) console.log('[eval]', typeof v === 'string' ? v.slice(0, 2000) : JSON.stringify(v).slice(0, 2000));
  if (r.result?.exceptionDetails) { threw = true; console.log('[eval error]', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); } };
await ev(opt('eval'));
await new Promise(r => setTimeout(r, WAIT));
await ev(opt('eval2'));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (out) { writeFileSync(out, Buffer.from(shot.result.data, 'base64')); console.log('saved', out); }
ws.close(); cleanup();
process.exit(threw ? 1 : 0);
