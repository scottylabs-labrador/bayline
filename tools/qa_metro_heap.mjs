#!/usr/bin/env node
// Bayline Metro JS heap per module (M3): loads the page with a few variants (metro off, on, and on with one module
// skipped: #metroskip=sim|stations|track, #mground=0), waits, forces two garbage collections over the DevTools
// protocol and reads the heap. Optionally (--snap) also writes a constructor-level summary of a heap snapshot for the
// metro-on and metro-off pages (self sizes by node name), to see which kinds of objects the metro adds.
// Usage: node tools/qa_metro_heap.mjs [page url] [view hash, default at=palo_alto&t=08:03&q=low] [--mobile] [--snap]
//        (under tools/wd.py; one headless Chrome per variant, one at a time)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), flag = (k) => args.includes('--' + k), pos = args.filter(a => !a.startsWith('--'));
const PAGE = pos[0] || 'http://127.0.0.1:8136/sim.html', VIEW = pos[1] || 'at=palo_alto&t=08:03&q=low', WAIT = +(process.env.HEAP_WAIT || 45000);
const MOBILE = flag('mobile'), SNAP = flag('snap');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VARIANTS = (process.env.HEAP_VARIANTS || 'metro=0|metro=1|metro=1&metroskip=sim|metro=1&metroskip=stations|metro=1&metroskip=track|metro=1&mground=0|metro=1&metroskip=sim,stations,track&mground=0').split('|');

async function run(variant, snap) {
  const prof = mkdtempSync(join(tmpdir(), 'heap-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const done = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} };
  try {
    let port = 0; for (let i = 0; i < 100 && !port; i++) { const f = join(prof, 'DevToolsActivePort'); if (existsSync(f)) port = +readFileSync(f, 'utf8').split('\n')[0]; if (!port) await sleep(100); }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), pg = list.find(t => t.type === 'page');
    const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), chunks = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable'); await send('HeapProfiler.enable');
    await send('Emulation.setDeviceMetricsOverride', MOBILE ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${PAGE}#auto&${variant}&${VIEW}` });
    await sleep(WAIT);
    await send('HeapProfiler.collectGarbage'); await sleep(500); await send('HeapProfiler.collectGarbage');
    const hu = (await send('Runtime.getHeapUsage')).result;
    const st = (await send('Runtime.evaluate', { expression: `JSON.stringify({metro:!!(window.__bayline&&__bayline.Metro&&__bayline.Metro.on),sim:!!(window.__bayline&&__bayline.MetroSim&&__bayline.MetroSim.ready)})`, returnByValue: true })).result.result.value;
    let top = null;
    if (snap) {
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      const S = JSON.parse(chunks.join('')), f = S.snapshot.meta.node_fields, N = f.length, iName = f.indexOf('name'), iType = f.indexOf('type'), iSize = f.indexOf('self_size');
      const types = S.snapshot.meta.node_types[0], by = new Map();
      for (let i = 0; i < S.nodes.length; i += N) { const ty = types[S.nodes[i + iType]]; const nm = ty === 'object' || ty === 'native' ? S.strings[S.nodes[i + iName]] : '(' + ty + ')'; by.set(nm, (by.get(nm) || 0) + S.nodes[i + iSize]); }
      top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, +(v / 1048576).toFixed(2)]);
    }
    return { variant, usedMB: +(hu.usedSize / 1048576).toFixed(1), totalMB: +(hu.totalSize / 1048576).toFixed(1), state: JSON.parse(st), top };
  } finally { done(); }
}
const out = [];
for (const v of VARIANTS) { const r = await run(v, SNAP && (v === 'metro=0' || v === 'metro=1')); out.push(r); console.log(JSON.stringify({ variant: r.variant, usedMB: r.usedMB, totalMB: r.totalMB, state: r.state })); }
const base = out.find(r => r.variant === 'metro=0'), full = out.find(r => r.variant === 'metro=1');
if (base && full) {
  console.log(`metro adds ${(full.usedMB - base.usedMB).toFixed(1)} MB of JS heap at this view`);
  for (const r of out) if (r !== base && r !== full) console.log(`  without ${r.variant.replace('metro=1&', '')}: -${(full.usedMB - r.usedMB).toFixed(1)} MB`);
  if (SNAP && base.top && full.top) {
    const b = new Map(base.top), rows = full.top.map(([k, v]) => [k, v, +(v - (b.get(k) || 0)).toFixed(2)]).sort((x, y) => y[2] - x[2]).slice(0, 20);
    console.log('snapshot: biggest growth by node name (MB self size: metro on, growth)'); for (const r of rows) console.log('  ', r.join('  '));
    writeFileSync('/tmp/bayline-heap-top.json', JSON.stringify({ base: base.top, full: full.top }, null, 1));
  }
}
