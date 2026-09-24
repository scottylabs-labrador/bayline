#!/usr/bin/env node
// Trailer title cards: HTML (the site's own fonts and colours) rendered to transparent 1920x1080 PNGs.
//   node tools/trailer/titles.mjs <outdir> [scale]      (scale 2: 3840x2160 cards for a 4K master)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] || 'titles'); mkdirSync(out, { recursive: true }); const SCALE = +(process.argv[3] || 1);
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
html, body { margin: 0; width: 1920px; height: 1080px; background: transparent; overflow: hidden; }
.c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #f3efe6; text-align: center; }
.w { font-family: 'Barlow Condensed'; font-weight: 700; font-size: 150px; letter-spacing: .04em; line-height: .92; text-transform: uppercase;
     text-shadow: 0 0 40px rgba(0,0,0,.55), 0 4px 18px rgba(0,0,0,.6); }
.w em { font-style: normal; color: #e0402f; }
.k { font-family: 'Barlow Condensed'; font-weight: 600; font-size: 38px; letter-spacing: .32em; text-transform: uppercase; color: #f3efe6; opacity: .92;
     text-shadow: 0 2px 14px rgba(0,0,0,.7); }
.logo { font-family: 'Barlow Condensed'; font-weight: 700; font-size: 250px; line-height: .9; letter-spacing: .01em; text-shadow: 0 6px 40px rgba(0,0,0,.5); }
.logo span { color: #e0402f; }
.tag { font-family: 'Barlow'; font-weight: 500; font-size: 44px; margin-top: 18px; color: #f3efe6; }
.url { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 30px; margin-top: 46px; color: #f3efe6; opacity: .95; }
.url b { color: #e0402f; font-weight: 600; }
.play { font-family: 'Barlow Condensed'; font-weight: 600; font-size: 28px; letter-spacing: .3em; text-transform: uppercase; margin-top: 16px; color: rgba(243,239,230,.7); }
.scrim { position: absolute; left: 50%; top: 50%; width: 1500px; height: 760px; transform: translate(-50%, -50%); z-index: -1;
        background: radial-gradient(ellipse at center, rgba(4,7,12,.62) 0%, rgba(4,7,12,.38) 42%, rgba(4,7,12,0) 72%); }
.fine { position: absolute; left: 0; right: 0; bottom: 46px; font-family: 'Barlow'; font-size: 19px; color: rgba(243,239,230,.55); text-align: center; line-height: 1.5; }
`;
const cards = {
  kicker: `<div class="c" style="justify-content:flex-end;padding-bottom:150px"><div class="k">An unofficial rail &amp; flight simulator</div></div>`,
  every_train: `<div class="c"><div class="w">Every train</div></div>`,
  on_schedule: `<div class="c"><div class="w">On <em>schedule</em></div></div>`,
  take_off: `<div class="c"><div class="w">Now take <em>off</em></div></div>`,
  airports: `<div class="c"><div class="w">28,000 <em>airports</em></div></div>`,
  weather: `<div class="c"><div class="w">Real <em>weather</em></div></div>`,
  traffic: `<div class="c" style="justify-content:flex-start;padding-top:150px"><div class="w">Real <em>traffic</em></div></div>`,   // clear of the live callsign label
  world: `<div class="c"><div class="w">The whole <em>world</em></div></div>`,
  endcard: `<div class="c"><div class="scrim"></div><div class="logo">Bay<span>line</span></div><div class="tag">Trains. Planes. The whole world.</div>
    <div class="url">bayline.sheltie.<b>scottylabs</b>.org</div><div class="play">Free · in your browser</div>
    <div class="fine">Unofficial. Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board, or with any airline or aircraft manufacturer.<br>
    Real gameplay, captured in the browser. Music: “The Sound of Arrows” by Bonnie Grace · Epidemic Sound.</div></div>`,
};

// the end card again as separate layers (same layout, the other parts hidden) so the edit can reveal them one by one
{ const parts = { endcard_logo: ['scrim', 'logo'], endcard_tag: ['tag'], endcard_url: ['url', 'play'], endcard_fine: ['fine'] };
  for (const [name, show] of Object.entries(parts)) cards[name] = cards.endcard.replace(/class="(scrim|logo|tag|url|play|fine)"/g, (m, c) => show.includes(c) ? m : `class="${c}" style="visibility:hidden"`); }
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
let wsUrl = null; const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 20000) { const f = join(prof, 'DevToolsActivePort');
  if (existsSync(f)) { const [port] = readFileSync(f, 'utf8').split('\n'); if (+port > 0) try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch {} }
  if (!wsUrl) await new Promise(r => setTimeout(r, 100)); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: SCALE, mobile: false });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const [name, html] of Object.entries(cards)) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`;
  await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(doc).toString('base64') });
  await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))', awaitPromise: true });
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name + '.png'), Buffer.from(s.result.data, 'base64')); console.log('title', name);
}
ws.close(); cleanup(); process.exit(0);
