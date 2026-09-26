#!/usr/bin/env node
// Bayline Metro per-frame cost (M3.1): loads a view with the metro off and on (one headless Chrome per variant, one at
// a time, real GPU), lets it settle, then measures over the same number of frames: the frame time (rAF deltas), the
// main-thread script time per frame (Performance.getMetrics ScriptDuration), and a CPU profile whose self time is
// summed per source file of the build (the page's "// ===== NN_name.js =====" markers) and per metro function.
// Usage: node tools/qa_metro_cpu.mjs [page url] [view hash] [--w 1440] [--h 900] [--settle 30000] [--frames 400]
//        [--variants 'metro=0|metro=1'] [--rounds 1] [--json out.json] [--ab]   (under tools/wd.py; default view: sf_golden)
//        --ab N: on the metro-on page, N interleaved rounds of frame times: as is, the underground shader path off, MetroSim.update skipped
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const PAGE = pos[0] || 'http://127.0.0.1:8136/sim.html', VIEW = pos[1] || 't=18:50&at=san_francisco&cam=orbit&dist=900';
const W = +opt('w', 1440), H = +opt('h', 900), SETTLE = +opt('settle', 30000), FRAMES = +opt('frames', 400), ROUNDS = +opt('rounds', 1);
const VARIANTS = opt('variants', 'metro=0|metro=1').split('|'), JSON_OUT = opt('json', ''), AB = args.includes('--ab') ? +(opt('ab', '4')) || 4 : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// the build's file markers: line (1-based, in the page) -> file
const html = await (await fetch(PAGE.split('#')[0])).text();
const marks = []; html.split('\n').forEach((l, i) => { const m = /^\/\/ ===== (\S+\.js) =====$/.exec(l); if (m) marks.push([i + 1, m[1]]); });
const appLine = html.split('\n').findIndex(l => l.includes("(function(){'use strict';")) + 1;
function fileAt(line1) { if (line1 < appLine) return 'three.js'; let f = '(app)'; for (const [l, n] of marks) { if (l <= line1) f = n; else break; } return f; }
const isMetro = (f) => /metro|station(kit|parts|signs|types|crowds|heroes)|^18_metro|under/i.test(f) && f !== '25_stations.js';

async function run(variant) {
  const prof = mkdtempSync(join(tmpdir(), 'cpu-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const done = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} };
  process.on('exit', done);
  try {
    let port = 0; for (let i = 0; i < 100 && !port; i++) { const f = join(prof, 'DevToolsActivePort'); if (existsSync(f)) port = +readFileSync(f, 'utf8').split('\n')[0]; if (!port) await sleep(100); }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), pg = list.find(t => t.type === 'page');
    const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200)); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Performance.enable'); await send('Profiler.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${PAGE.split('#')[0]}#auto&${variant}&${VIEW}` });
    await ev(`new Promise(r=>{const f=()=>window.__bayline&&__bayline.Env&&__bayline.Env.renderer?r():setTimeout(f,200);f();})`);
    await sleep(SETTLE);
    const out = { variant, rounds: [] };
    for (let k = 0; k < ROUNDS; k++) {
      const metric = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
      const m0 = await metric();
      const fr = await ev(`new Promise(r=>{const d=[];let t0=performance.now(),n=0;const i=__bayline.Env.renderer.info;function f(t){d.push(t-t0);t0=t;if(++n<${FRAMES})requestAnimationFrame(f);else{d.shift();d.sort((a,b)=>a-b);
        r({mean:+(d.reduce((a,b)=>a+b,0)/d.length).toFixed(2),p50:+d[d.length>>1].toFixed(2),p90:+d[Math.floor(d.length*0.9)].toFixed(2),calls:i.render.calls,tris:i.render.triangles});}}requestAnimationFrame(f);})`);
      const m1 = await metric(), n = FRAMES - 1;
      await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start');
      await ev(`new Promise(r=>{let n=0;function f(){if(++n<${FRAMES})requestAnimationFrame(f);else r(1);}requestAnimationFrame(f);})`);
      const P = (await send('Profiler.stop')).result.profile;
      // self time per node: samples x the mean interval
      const dtMs = (P.endTime - P.startTime) / 1000 / Math.max(1, P.samples.length), cnt = new Map(); for (const s of P.samples) cnt.set(s, (cnt.get(s) || 0) + 1);
      const byFile = new Map(), byFn = new Map();
      for (const nd of P.nodes) { const c = cnt.get(nd.id); if (!c) continue; const cf = nd.callFrame, ms = c * dtMs;
        const file = cf.url && cf.url.startsWith('http') ? fileAt(cf.lineNumber + 1) : cf.functionName ? '(native)' : '(' + (cf.functionName || 'program') + ')';
        const k2 = cf.functionName === '(idle)' || cf.functionName === '(program)' || cf.functionName === '(garbage collector)' ? cf.functionName : file;
        byFile.set(k2, (byFile.get(k2) || 0) + ms);
        if (isMetro(file)) { const fk = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1 - (marks.find(x => x[1] === file) || [0])[0]}`; byFn.set(fk, (byFn.get(fk) || 0) + ms); } }
      const frames = n, per = (ms) => +(ms / frames).toFixed(3);
      const files = [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, ms]) => [f, per(ms)]);
      const metroMs = files.filter(([f]) => isMetro(f)).reduce((a, [, v]) => a + v, 0);
      const st = await ev(`JSON.stringify((()=>{const B=__bayline,S=B.MetroSim;return {metro:!!(B.Metro&&B.Metro.on),running:S&&S.running?S.running.length:0,simMs:S&&S.stats?+S.stats.ms.toFixed(3):null,far:S&&S.stats?S.stats.far:null,hidden:S&&S.stats?S.stats.hidden:null,consists:S&&S.stats?S.stats.consists:null,quiet:S&&S.stats?!!S.stats.quiet:null,cam:[Math.round(B.Env.camera.position.x),Math.round(B.Env.camera.position.y),Math.round(B.Env.camera.position.z)]};})())`);
      out.rounds.push({ frame: fr, scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / n).toFixed(3), taskMsPerFrame: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / n).toFixed(3),
        metroSelfMsPerFrame: +metroMs.toFixed(3), files: files.slice(0, 16), metroFns: [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([f, ms]) => [f, per(ms)]), state: JSON.parse(st) });
    }
    // --ab N (metro on): the same page with parts of the metro switched off in turn, N rounds of [base, under0, simoff]
    // interleaved so the machine's noise hits all three alike; frames only. under0 = the underground engine's shader path
    // off (blUMK.x = 0 after Under.update: every lit material, the terrain cut test and the post composite skip the under
    // map); simoff = MetroSim.update skipped. Reported: the median over rounds of each condition's p50 and mean.
    if (AB > 0 && out.rounds[0] && out.rounds[0].state.metro) {
      const frames = () => ev(`new Promise(r=>{const d=[];let t0=performance.now(),n=0;function f(t){d.push(t-t0);t0=t;if(++n<${Math.min(FRAMES, 240)})requestAnimationFrame(f);else{d.shift();d.sort((a,b)=>a-b);r({mean:+(d.reduce((a,b)=>a+b,0)/d.length).toFixed(2),p50:+d[d.length>>1].toFixed(2)});}}requestAnimationFrame(f);})`);
      await ev(`(()=>{const M=window.__baylineMods||{},Un=M.Under,S=__bayline.MetroSim;window.__abO={uu:Un&&Un.update,su:S.update,Un,S};return 1;})()`);
      const COND = { base: `const o=window.__abO;if(o.Un)o.Un.update=o.uu;o.S.update=o.su;`,
        under0: `const o=window.__abO;o.S.update=o.su;if(o.Un)o.Un.update=function(c){o.uu.call(this,c);const k=THREE.ShaderLib.standard.uniforms.blUMK;if(k){k.value.x=0;k.value.y=0;}};`,
        simoff: `const o=window.__abO;if(o.Un)o.Un.update=o.uu;o.S.update=function(){};` };
      const res = { base: [], under0: [], simoff: [] };
      for (let k = 0; k < AB; k++) for (const c of Object.keys(COND)) { await ev(`(()=>{${COND[c]};return 1;})()`); await sleep(800); res[c].push(await frames()); }
      await ev(`(()=>{${COND.base};return 1;})()`);
      const med = (a) => { const b = a.slice().sort((x, y) => x - y); return +b[b.length >> 1].toFixed(2); };
      out.ab = Object.entries(res).map(([c, L]) => [c, { p50: med(L.map(x => x.p50)), mean: med(L.map(x => x.mean)), n: L.length }]);
      const uk = await ev(`(()=>{const k=THREE.ShaderLib.standard.uniforms.blUMK;return k?[k.value.x,k.value.y]:null;})()`); out.underOn = uk;
    }
    out.errors = errors;
    return out;
  } finally { done(); }
}
const all = [];
for (const v of VARIANTS) {
  const r = await run(v); all.push(r);
  for (const [i, x] of r.rounds.entries()) {
    console.log(`${v}${ROUNDS > 1 ? ' #' + (i + 1) : ''}: frame ${x.frame.mean} ms (p50 ${x.frame.p50}, p90 ${x.frame.p90}) · calls ${x.frame.calls} · tris ${x.frame.tris} · script ${x.scriptMsPerFrame} ms/frame · tasks ${x.taskMsPerFrame} ms/frame · metro self ${x.metroSelfMsPerFrame} ms/frame · ${JSON.stringify(x.state)}`);
    console.log('   by file (ms/frame): ' + x.files.map(([f, v2]) => `${f} ${v2}`).join(' · '));
    if (x.metroFns.length) console.log('   metro functions (ms/frame): ' + x.metroFns.map(([f, v2]) => `${f} ${v2}`).join(' · '));
  }
  if (r.ab) console.log(`   A/B on the same page, ${r.ab[0][1].n} interleaved rounds (median frame mean / p50 ms; under map switch ${JSON.stringify(r.underOn)}): ` + r.ab.map(([n, f]) => `${n} ${f.mean}/${f.p50}`).join(' · '));
  if (r.errors.length) console.log('   page errors: ' + r.errors.slice(0, 5).join(' | '));
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
process.exit(0);
