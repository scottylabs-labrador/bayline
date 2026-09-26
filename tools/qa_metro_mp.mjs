#!/usr/bin/env node
// QA (Bayline Metro, M3 gate item 7): two clients on one relay see each other. One headless Chrome, two pages, a local
// relay (server/mp.py on MP_PORT, default 8766). At Millbrae (the shared station):
//   A boards a metro train at the metro platform (mode 8 'mride'), B walks the Peninsula platform (mode 1 'walk');
//   B must see A in B's own copy of that metro car and A must see B on the platform; then A takes the train over and
//   drives it (mode 9 'mdrive'): B's copy of the train must follow A's position.
// Usage: node tools/qa_metro_mp.mjs [page url, default http://127.0.0.1:8136/sim.html] [outdir]
// (run it under tools/wd.py; one Chrome; the relay and Chrome are stopped on exit)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.argv[2] || 'http://127.0.0.1:8136/sim.html', OUT = process.argv[3] || '/tmp/bayline-metro-mp';
const MP_PORT = +(process.env.MP_PORT || 8766), T = process.env.QA_T || '08:05';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const procs = [];
let prof = null;
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } if (prof) try { rmSync(prof, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

// ---- the relay
const relay = spawn('python3', [join(ROOT, 'server/mp.py')], { env: { ...process.env, MP_PORT: String(MP_PORT), MP_HOST: '127.0.0.1', MP_MAX_PER_IP: '10', MP_TICK_HZ: '2' }, stdio: ['ignore', 'ignore', 'pipe'] });
procs.push(relay); let relayLog = ''; relay.stderr.on('data', d => { relayLog += d; });
for (let i = 0; i < 50; i++) { const ok = await new Promise(r => { const s = net.connect(MP_PORT, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); }); if (ok) break; await sleep(200); }

// ---- one Chrome, two pages
prof = mkdtempSync(join(tmpdir(), 'mp-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--window-size=1280,800', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
procs.push(chrome);
let port = 0; for (let i = 0; i < 100 && !port; i++) { const f = join(prof, 'DevToolsActivePort'); if (existsSync(f)) port = +readFileSync(f, 'utf8').split('\n')[0]; if (!port) await sleep(100); }
if (!port) { console.error('chrome did not start'); process.exit(2); }
const jget = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${p}`, { method })).json();
// each client gets its own window (a background tab would have no animation frames, so the game would never start)
const bws = new WebSocket((await jget('/json/version')).webSocketDebuggerUrl); await new Promise(r => bws.onopen = r);
let bid = 0; const bpend = new Map(); bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m); bpend.delete(m.id); } };
const bsend = (method, params = {}) => new Promise(r => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
async function page() {
  const { result } = await bsend('Target.createTarget', { url: 'about:blank', newWindow: true });
  let t = null; for (let i = 0; i < 50 && !t; i++) { t = (await jget('/json/list')).find(x => x.id === result.targetId); if (!t) await sleep(100); }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(), logs = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[pageerror] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const ev = async (code) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); };
  return { ws, send, ev, shot, logs };
}
const A = await page(), B = await page();
console.log('== two windows; relay on', MP_PORT);
const url = (h) => `${PAGE}#auto&metro=1&t=${T}&${h}`;
await A.send('Page.navigate', { url: url('mst=MLBR') });
await B.send('Page.navigate', { url: url('at=place_MLBR') });
const READY = `new Promise(r=>{const f=()=>window.__bayline&&__bayline.MetroSim&&__bayline.MetroSim.ready&&__bayline.Net?r(1):setTimeout(f,250);f();})`;
await A.ev(READY); await B.ev(READY); console.log('== both pages running the metro');
const RELAY = `ws://127.0.0.1:${MP_PORT}`;
const CONNECT = `(()=>{const N=__bayline.Net;N.disconnect();N.connect('${RELAY}');return new Promise(r=>{const f=(n)=>N.status.online||n>80?r(N.status.state):setTimeout(()=>f(n+1),250);f(0);});})()`;
const result = { steps: [], ok: true };
const step = (s, ok, extra) => { result.steps.push({ s, ok, ...(extra || {}) }); if (!ok) result.ok = false; console.log((ok ? 'PASS ' : 'FAIL ') + s + (extra ? ' ' + JSON.stringify(extra) : '')); };
step('A connected', (await A.ev(CONNECT)) === 'online'); step('B connected', (await B.ev(CONNECT)) === 'online');
// both clocks to 25 s after the next train pulls in at the metro platform (doors open), so A can board and B has the
// same train running
const tArr = await A.ev(`(()=>{const M=__bayline.MetroSim,now=__bayline.Env.time.sec;const e=M.arrivals('MLBR',now+60,40,{withLast:true}).find(e=>e.leg.kind==='bart');return e?e.arr:now;})()`);
for (const P of [A, B]) await P.ev(`(()=>{__bayline.Env.setClock(${tArr + 25});__bayline.Env.time.scale=1;return 1;})()`);
await sleep(9000);                                                      // (streaming, the train at the metro platform)

// A: board the train at the metro platform (wait for one with its doors open, sit it in car 3)
const BOARD = `new Promise(r=>{const B=__bayline,M=B.MetroSim,P=B.Player;let n=0;const f=()=>{n++;
  const tr=M.running.filter(t=>t.entry&&t.stationId==='MLBR'&&t.doorsOpen).sort((a,b)=>a.dist-b.dist)[0];
  if(tr){const cars=tr.entry.consist.cars,ci=Math.min(2,cars.length-1),car=cars[ci],side=tr.doorSide==='right'?1:-1,d=car.doors.find(x=>x.side===side)||car.doors[0];
    P.board({tr,ci,d});return r(JSON.stringify({mode:P.mode,trip:M.netKey(tr),line:tr.line}));}
  if(n>240)return r(JSON.stringify({mode:P.mode,none:true}));setTimeout(f,500);};f();})`;
const boarded = JSON.parse(await A.ev(BOARD));
step('A boarded a metro train at Millbrae', boarded.mode === 'onboard', boarded);
await sleep(6000);
const SEE = (who) => `(()=>{const B=__bayline,M=B.MetroSim;const o=B.Net.others();const me=B.Net.status.id;
  const oth=o.map(x=>({id:x.id,mode:x.modeName,trip:x.trip,s:+(x.s||0).toFixed(1),x:Math.round(x.x),z:Math.round(x.z)}));
  const tr=o.filter(x=>x.modeName==='mride'||x.modeName==='mdrive').map(x=>{const t=M.running.find(r=>M.netKey(r)===x.trip);return t?{key:x.trip,near:!!t.entry,remote:!!t.remote,s:+t.s.toFixed(1),driven:t.driven}:null;});
  return JSON.stringify({me,mode:B.Player.mode,state:B.Player.state().mode,others:oth,trains:tr});})()`;
let a = JSON.parse(await A.ev(SEE('A'))), b = JSON.parse(await B.ev(SEE('B')));
step('A sends mride', a.state === 'mride', { state: a.state });
step('B sees A riding a metro car', b.others.some(o => o.mode === 'mride' && o.trip === boarded.trip), { others: b.others });
step('B has that train near (A drawn in its car)', !!(b.trains[0] && b.trains[0].near), { trains: b.trains });
step('A sees B walking the Peninsula platform', a.others.some(o => o.mode === 'walk'), { others: a.others });
await A.shot('A_riding.png'); await B.shot('B_platform.png');

// A takes the train over and drives it (ATO): B's copy of the train follows A
const DRIVE = `(()=>{const B=__bayline,M=B.MetroSim,now=B.Env.time.sec;const ev=M.arrivals('MLBR',now,20).find(e=>e.dep>now+3&&e.leg.kind==='bart'&&e.k<e.leg.stops.length-1);if(!ev)return 'no train';const r=B.MetroATC.start(ev.plan,{station:'MLBR'});return r?'driving':'no run';})()`;
step('A starts driving', (await A.ev(DRIVE)) === 'driving');
const tA = await A.ev('__bayline.Env.time.sec'); await B.ev(`(()=>{__bayline.Env.setClock(${tA});return 1;})()`);   // (B on A's clock: the same trips run)
await A.ev(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true}));return 1;})()`);
await sleep(8000);
a = JSON.parse(await A.ev(SEE('A'))); b = JSON.parse(await B.ev(SEE('B')));
step('A sends mdrive', a.state === 'mdrive', { state: a.state });
step('B sees A driving', b.others.some(o => o.mode === 'mdrive'), { others: b.others });
step('B\'s copy of the train follows A (remote)', b.trains.some(t => t && t.remote), { trains: b.trains });
await A.shot('A_driving.png'); await B.shot('B_sees_driver.png');
const errs = [...A.logs, ...B.logs].filter(l => /\[pageerror\]|\[console\.error\]/.test(l));
step('no page or console errors', errs.length === 0, errs.length ? { errs: errs.slice(0, 5) } : undefined);
writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 1));
console.log(result.ok ? '== PASS' : '== FAIL', OUT);
cleanup(); process.exit(result.ok ? 0 : 1);
