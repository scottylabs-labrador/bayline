// Bayline Metro UI (#metro=1 only): the system map (schematic or geographic, live trains, line filter, station
// search, click to go), arrivals boards (per platform; also pushed to the stations' platform displays), train info,
// the ride panel (the car's next-stop screen, in the HUD) and the driver's display. Same look as 66_ui.js / head.html:
// dark glass panels, Barlow / IBM Plex Mono, the red kicker. Everything is built from JS so head.html stays untouched.
const MetroUI = (() => {
  const on = () => typeof MetroSim !== 'undefined' && MetroSim.enabled;
  const ready = () => on() && MetroSim.ready;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MPH = 0.44704;
  const LINE_ORDER = ['yellow', 'red', 'orange', 'green', 'blue', 'ebart', 'grey'];
  const hidden = new Set();                                  // line filter
  const el = {};
  let built = false;

  // ---------------------------------------------------------------- styles and DOM
  const CSS = `
  .mchip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px 3px 6px;font-family:var(--cond);font-weight:600;font-size:13px;letter-spacing:.02em;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink)}
  .mchip i{width:14px;height:14px;border-radius:50%;display:inline-block;box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.25)}
  .mchip.off{opacity:.38} button.mchip{cursor:pointer}
  #msys .card{width:min(1280px,97vw);padding:18px 20px 14px}
  #msys .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  #msys h2{margin:2px 14px 0 0}
  #msys .seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  #msys .seg button{border:none;background:transparent;padding:7px 12px;font-size:13px;color:var(--ink-dim)} #msys .seg button.on{background:rgba(255,255,255,.14);color:var(--ink)}
  #msys input{background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:10px;padding:8px 12px;color:var(--ink);font:inherit;font-size:14px;width:200px;outline:none}
  #msys .wrap{position:relative;display:grid;grid-template-columns:1fr 300px;gap:12px}
  #msys canvas{width:100%;height:70vh;display:block;border-radius:12px;background:#0d1217;cursor:grab}
  #msys .side{height:70vh;overflow:auto;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid var(--line);font-size:14px}
  #msys .side h3{font-family:var(--cond);font-size:24px;margin:2px 0 4px}
  #msys .side .sub{color:var(--ink-dim);font-size:13px;margin-bottom:10px}
  #msys .res{position:absolute;left:12px;top:12px;width:240px;max-height:40vh;overflow:auto;z-index:2}
  #msys .res button{display:block;width:100%;text-align:left;border:none;background:rgba(16,19,24,.92);padding:8px 12px;border-bottom:1px solid var(--line);font-size:14px}
  #msys .res button:hover{background:rgba(60,70,84,.95)}
  #msys .foot{display:flex;flex-wrap:wrap;justify-content:space-between;column-gap:16px;row-gap:3px;color:var(--ink-faint);font-size:12.5px;margin-top:8px} #msys .foot .legal{flex-basis:100%}
  .mrow{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--line);cursor:pointer}
  .mrow:hover{background:rgba(255,255,255,.06)}
  .mrow .t{font-family:var(--mono);font-size:13px;color:var(--ink-dim);text-align:right;white-space:nowrap} .mrow .t b{color:var(--ink);font-size:16px}
  .mrow .d{font-weight:600} .mrow .d small{display:block;font-weight:400;color:var(--ink-faint);font-size:12px}
  .mbar{width:6px;height:34px;border-radius:3px}
  #mboard .card{width:min(1060px,96vw)}
  #mboard .plats{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:6px}
  #mboard .plat{background:rgba(255,255,255,.035);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
  #mboard .plat h4{margin:0 0 6px;font-family:var(--cond);font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);font-weight:600}
  #mboard .led{font-family:var(--mono);color:#ffb347;background:#0a0b0c;border-radius:8px;padding:8px 10px;margin:8px 0 2px;font-size:13.5px;letter-spacing:.04em;min-height:1.4em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #mboard .conn{margin-top:12px;color:var(--ink-dim);font-size:13.5px}
  #mboard .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  #mride{position:absolute;left:16px;bottom:16px;width:360px;padding:0;overflow:hidden}
  #mride .hd{display:flex;align-items:center;gap:10px;padding:11px 14px 9px;border-bottom:1px solid var(--line)}
  #mride .hd i{width:12px;height:30px;border-radius:3px}
  #mride .hd b{font-family:var(--cond);font-size:21px;line-height:1.05} #mride .hd small{display:block;color:var(--ink-dim);font-size:12.5px;font-family:var(--font);font-weight:500}
  #mride .ns{padding:10px 14px 4px;display:flex;justify-content:space-between;align-items:flex-end}
  #mride .ns .k{font-family:var(--cond);letter-spacing:.2em;text-transform:uppercase;font-size:11px;color:var(--ink-faint)}
  #mride .ns .n{font-family:var(--cond);font-size:28px;font-weight:700;line-height:1.05}
  #mride .ns .sp{font-family:var(--mono);font-size:26px;font-weight:600;text-align:right} #mride .ns .sp small{font-size:12px;color:var(--ink-dim);margin-left:4px}
  #mride .inf{padding:2px 14px 10px;color:var(--ink-dim);font-size:13px;min-height:1.3em}
  #mride canvas{display:block;width:100%;height:66px}
  #mdmi{position:absolute;left:16px;bottom:16px;width:372px;padding:14px 16px}
  #mdmi .top{display:flex;align-items:flex-end;gap:12px}
  #mdmi .spd{font-family:var(--mono);font-size:48px;font-weight:600;line-height:.9} #mdmi .u{color:var(--ink-dim);font-size:13px}
  #mdmi .code{margin-left:auto;text-align:center;border:2px solid #6fe39a;color:#6fe39a;border-radius:10px;padding:3px 10px 2px;font-family:var(--mono);font-weight:600;font-size:24px;min-width:66px}
  #mdmi .code small{display:block;font-family:var(--cond);font-size:10px;letter-spacing:.18em;color:var(--ink-dim)}
  #mdmi .code.warn{border-color:#ffc53d;color:#ffc53d} #mdmi .code.alarm{border-color:#ff5a4a;color:#ff5a4a;animation:blink .5s steps(2) infinite}
  #mdmi .gauge{position:relative;height:8px;border-radius:4px;background:rgba(255,255,255,.09);margin:12px 0 4px}
  #mdmi .gauge i{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:#dfe6ee}
  #mdmi .gauge b{position:absolute;top:-4px;width:3px;height:16px;background:#6fe39a;border-radius:2px}
  #mdmi .row{display:flex;gap:8px;align-items:center;margin-top:8px}
  #mdmi .pill{font-family:var(--mono);font-size:12px;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.08)}
  #mdmi .pill.ato{background:#1f6f4a;color:#dfffee} #mdmi .pill.man{background:#6b4a14;color:#ffe6b8} #mdmi .pill.p{background:var(--green);color:#0b0d10} #mdmi .pill.b{background:#c0392b;color:#fff} #mdmi .pill.eb{background:#ff2d2d;color:#fff;animation:blink .5s steps(2) infinite}
  #mdmi .grid{display:grid;grid-template-columns:1fr 1fr;gap:5px 14px;margin-top:10px;font-size:13px} #mdmi .grid span{color:var(--ink-dim)} #mdmi .grid b{font-family:var(--mono);font-weight:600}
  #mdmi .guide{margin-top:10px;font-weight:600;font-size:14px;line-height:1.35;min-height:1.35em} #mdmi .guide.warn{color:#ffc53d} #mdmi .guide.alarm{color:#ff5a4a}
  #mstrip{position:absolute;right:16px;top:70px;bottom:90px;width:200px;padding:10px 12px;overflow:hidden;pointer-events:auto}
  body.mdriving #mstrip{right:136px}
  #mstrip canvas{width:100%;height:100%;display:block}
  #title{display:flex;overflow-y:auto;overscroll-behavior:contain} #title .card{margin:auto}   /* (a tall title card scrolls instead of being cut off) */
  #title .mfront{margin:-4px 0 14px;padding:13px 14px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:linear-gradient(100deg,rgba(0,153,204,.13),rgba(255,153,51,.07) 48%,rgba(255,255,51,.05))}
  #title .mfront .top{display:flex;align-items:center;gap:14px}
  #title .mfront .ico{flex:none;display:block}
  #title p.lede .short{display:none}
  #title .foot details{display:inline} #title .foot summary{display:inline;cursor:pointer;color:var(--ink-dim);list-style:none;white-space:nowrap} #title .foot summary::-webkit-details-marker{display:none}
  #title .foot summary::after{content:' ▸'} #title .foot details[open] summary::after{content:' ▾'} #title .foot details[open] div{margin-top:4px}
  #title .mfront .t{flex:1;min-width:0;line-height:1.3} #title .mfront .t b{font-size:18px;display:block} #title .mfront .t small{color:var(--ink-dim);font-size:13px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #title .mfront .acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
  #title .mfront .acts .btn{padding:9px 14px;font-size:14px;white-space:nowrap} #title .mfront .acts .btn.go{border-color:rgba(0,153,204,.75);background:rgba(0,153,204,.22)} #title .mfront .acts .btn.go:hover{background:rgba(0,153,204,.34)}
  #title .mfront .pick{margin-top:12px;display:flex;flex-direction:column;gap:10px}
  #title .mfront .pick .row{display:flex;gap:8px;align-items:center}
  #title .mfront .pick input{flex:1;min-width:0;background:rgba(0,0,0,.28);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;font-size:15px;padding:9px 12px;outline:none}
  #title .mfront .pick input:focus{border-color:rgba(255,255,255,.34)}
  #title .mfront .pick .opts{display:flex;flex-wrap:wrap;gap:6px}
  #title .mfront .pick .opts .chip{color:var(--ink);display:inline-flex;align-items:center;gap:6px} #title .mfront .pick .opts .chip:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.3)}
  #title .mfront .pick .opts .chip i{width:7px;height:7px;border-radius:50%;display:inline-block}
  #title .mfront .pick .hint{color:var(--ink-faint);font-size:12.5px}
  #hmetro{display:inline-flex;align-items:center;gap:7px} #hmetro .ico{display:block}
  #hmetro.on{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.32)}
  @media (max-width:760px){#title p.lede .full{display:none} #title p.lede .short{display:inline} #title .mfront .t small{white-space:normal} #title .mfront .t small .lv{display:none} #title .mfront .top{flex-wrap:wrap} #title .mfront .acts{width:100%;justify-content:stretch} #title .mfront .acts .btn{flex:1 1 auto} #msys .wrap{grid-template-columns:1fr} #msys .side{height:auto;max-height:30vh} #msys canvas{height:52vh} #mride,#mdmi{width:auto;right:12px;left:12px;bottom:112px} #mstrip{display:none}}`;
  function build() {
    if (built || !on()) return; built = true;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const add = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); const n = d.firstChild; document.body.appendChild(n); return n; };
    el.sys = add(`<div class="overlay" id="msys" hidden><div class="card panel"><button class="close" data-mclose>×</button>
      <div class="kicker">Bayline Metro · live</div>
      <div class="bar"><h2>System map</h2>
        <div class="seg" id="mview"><button data-v="schematic" class="on">Schematic</button><button data-v="geo">Geographic</button><button data-v="graph" title="Time-distance graph of one line: every train of the next hour and a half">Train graph</button></div>
        <input id="msearch" placeholder="Find a station…" autocomplete="off" spellcheck="false">
        <button class="chip" id="mlive" title="Place every train from the operator's real-time predictions"><span class="dot" id="mlivedot"></span><span id="mlivet">Live positions</span></button>
        <span id="mlines" style="display:flex;gap:6px;flex-wrap:wrap"></span></div>
      <div class="wrap"><div style="position:relative"><canvas id="msysc"></canvas><div class="res panel" id="mres" hidden></div></div><div class="side" id="mside"></div></div>
      <div class="foot"><span id="mfoot"></span><span>Click a station to see its trains, a train to follow it. Scroll to zoom, drag to pan. <kbd>N</kbd> opens this map.</span><span class="legal">Unofficial. Not affiliated with the San Francisco Bay Area Rapid Transit District. Timetable: public GTFS feed; live positions: GTFS-Realtime.</span></div></div></div>`);
    el.board = add(`<div class="overlay" id="mboard" hidden><div class="card panel"><button class="close" data-mclose>×</button>
      <div class="kicker" id="mbk">Arrivals</div><h2 id="mbt">Station</h2><div id="mbsub" style="color:var(--ink-dim);margin:-6px 0 8px;font-size:14px"></div>
      <div class="plats" id="mbp"></div><div class="conn" id="mbc"></div><div class="acts" id="mba"></div>
      <p style="color:var(--ink-faint);font-size:13px;margin:12px 0 0" id="mbhint">Click a train to ride it (you'll be on its platform a minute before it arrives), <kbd>Shift</kbd>+click to drive it.</p></div></div>`);
    if (matchMedia('(pointer: coarse)').matches) document.getElementById('mbhint').textContent = 'Tap a train to ride it: you\'ll be on its platform a minute before it arrives. To drive one, tap it on the system map, then Drive.';
    const hud = $('hud') || document.body;
    const addH = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); const n = d.firstChild; hud.appendChild(n); return n; };
    el.ride = addH(`<div id="mride" class="panel" hidden><div class="hd"><i id="mrc"></i><div><b id="mrl">—</b><small id="mrd"></small></div></div>
      <div class="ns"><div><div class="k" id="mrk">Next station</div><div class="n" id="mrn">—</div></div><div class="sp" id="mrs">0<small>mph</small></div></div>
      <div class="inf" id="mri"></div><canvas id="mrline"></canvas></div>`);
    el.dmi = addH(`<div id="mdmi" class="panel" hidden><div class="top"><div><span class="spd" id="mds">0</span><span class="u"> mph</span></div><div class="code" id="mdc"><small>ATC</small><span id="mdcv">--</span></div></div>
      <div class="gauge"><i id="mdg"></i><b id="mdgb"></b></div>
      <div class="row"><span class="pill" id="mdm">ATO</span><span class="pill" id="mdn">N</span><span class="pill" id="mdd">DOORS</span><span style="flex:1"></span><span class="pill" id="mdsc">0</span></div>
      <div class="guide" id="mdgd"></div>
      <div class="grid"><span>Next station</span><b id="mdns">—</b><span>To the berth</span><b id="mdto">—</b><span>Schedule</span><b id="mdsch">—</b><span>Next code</span><b id="mdtr">—</b></div></div>`);
    el.strip = addH(`<div id="mstrip" class="panel" hidden><canvas id="mstripc"></canvas></div>`);
    for (const id of ['mlive', 'mlivedot', 'mlivet', 'msysc', 'mside', 'mres', 'msearch', 'mlines', 'mfoot', 'mview', 'mbk', 'mbt', 'mbsub', 'mbp', 'mbc', 'mba', 'mrc', 'mrl', 'mrd', 'mrk', 'mrn', 'mrs', 'mri', 'mrline', 'mds', 'mdc', 'mdcv', 'mdg', 'mdgb', 'mdm', 'mdn', 'mdd', 'mdsc', 'mdgd', 'mdns', 'mdto', 'mdsch', 'mdtr', 'mstripc']) el[id] = $(id);
    document.querySelectorAll('[data-mclose]').forEach(b => b.addEventListener('click', () => closeAll()));
    for (const o of [el.sys, el.board]) o.addEventListener('mousedown', (e) => { if (e.target === o) closeAll(); });
    el.mview.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { setView(b.dataset.v); }));
    el.msearch.addEventListener('input', () => search(el.msearch.value));
    el.msearch.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const b = el.mres.querySelector('button'); if (b) b.click(); } if (e.key === 'Escape') { el.msearch.value = ''; search(''); el.msearch.blur(); } });
    initMap();
    el.mlive.addEventListener('click', () => { if (typeof MetroLive !== 'undefined') MetroLive.setOn(!MetroLive.on); });
    if (typeof MetroLive !== 'undefined') MetroLive.onChange((st) => { el.mlivedot.classList.toggle('on', st.on && !st.error); el.mlive.classList.toggle('on', st.on);
      el.mlivet.textContent = !st.on ? 'Live positions' : st.error ? 'Live: ' + st.error : st.matched >= 0 ? `Live: ${st.matched} trains from ${st.source === 'gtfs-rt' ? 'real-time trip updates' : 'real-time departures'}` : 'Live: connecting…';
      if (st.on && st.error && typeof UI !== 'undefined') UI.toast(st.error, 5); });
    if (typeof UI !== 'undefined' && UI.addOverlay) { UI.addOverlay(el.sys); UI.addOverlay(el.board); }
    titleCard(); hudButton();
  }
  function closeAll() { if (el.sys) el.sys.hidden = true; if (el.board) el.board.hidden = true; }
  // the metro failed (Metro.fail): every metro panel, button and overlay goes away; the page is as without the metro
  function shutdown() {
    closeAll(); document.body.classList.remove('mdriving');
    for (const k of ['ride', 'dmi', 'strip']) if (el[k]) el[k].hidden = true;
    for (const n of document.querySelectorAll('[data-metro-ui]')) n.remove();
    restoreCard();
    const bar = document.getElementById('drivebar');
    if (bar) for (const b of bar.querySelectorAll('button')) { if (b.dataset.pen) b.textContent = b.dataset.pen; if (b.dataset.k === 'KeyG') b.hidden = false; }
  }
  if (typeof Metro !== 'undefined') Metro.onTeardown(shutdown);
  const anyOpen = () => !!(el.sys && (!el.sys.hidden || !el.board.hidden));

  // ---------------------------------------------------------------- the front door (title card, HUD button, search)
  // The title card gets a Bayline Metro section under the four modes: ride from a station, drive a train, the system
  // map. Ride and Drive open a small chooser in place (station search with the stations' aliases, or the drive runs);
  // the choice starts the game (__bayline.start('metro', { action, station | mission })) and MetroUI.front() carries it
  // out as soon as the metro has loaded.
  const LINE_BARS = ['#ffff33', '#ff0000', '#ff9933', '#339933', '#0099cc'];
  // five thin strokes in the line colours, fanning in from the left like the lines meeting at the Oakland Wye
  function bars(w = 30, h = 22, sw = 2) {
    const n = LINE_BARS.length, y0 = (i) => sw + i * (h - 2 * sw) / (n - 1), y1 = (i) => h / 2 + (i - (n - 1) / 2) * sw * 1.15;
    return `<svg class="ico" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${LINE_BARS.map((c, i) =>
      `<path d="M1 ${y0(i).toFixed(2)} C ${(w * 0.45).toFixed(1)} ${y0(i).toFixed(2)} ${(w * 0.5).toFixed(1)} ${y1(i).toFixed(2)} ${w - 1} ${y1(i).toFixed(2)}" stroke="${c}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`).join('')}</svg>`;
  }
  const RIDE_PICKS = ['EMBR', 'POWL', '16TH', '12TH', 'MCAR', 'DBRK', 'SFIA', 'MLBR'];
  let fr = null;                                                // the title section's elements
  function titleCard() {
    const modes = document.querySelector('#title .modes'); if (!modes || fr) return;
    const d = document.createElement('div'); d.className = 'mfront'; d.dataset.metroUi = '';
    d.innerHTML = `<div class="top">${bars()}<div class="t"><b>Bayline Metro</b><small>50 stations · 5 lines + airport connector<span class="lv"> · live</span></small></div>
      <div class="acts"><button class="btn go" data-mf="ride" title="Start on a platform of any station as the next train pulls in">Ride</button><button class="btn" data-mf="drive" title="Drive a metro train under automatic train control">Drive</button><button class="btn" data-mf="map" title="Every train running now">System map</button></div></div>
      <div class="pick" hidden><div class="row"><input autocomplete="off" spellcheck="false"><button class="chip" data-mf="back">Back</button></div><div class="opts"></div><div class="hint"></div></div>`;
    modes.after(d);
    fr = { root: d, pick: d.querySelector('.pick'), input: d.querySelector('.pick input'), opts: d.querySelector('.pick .opts'), hint: d.querySelector('.pick .hint'), kind: '' };
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-mf]'); if (!b) return; const a = b.dataset.mf;
      if (a === 'map') go({ action: 'map' });
      else if (a === 'ride' || a === 'drive') openPick(a);
      else if (a === 'back') { fr.pick.hidden = true; fr.kind = ''; }
      else if (a === 'st') go({ action: 'ride', station: b.dataset.id });
      else if (a === 'mission') go({ action: 'drive', mission: b.dataset.id }); });
    fr.input.addEventListener('input', () => renderPick());
    fr.input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const b = fr.opts.querySelector('[data-mf="st"]'); if (b) b.click(); } if (e.key === 'Escape') { fr.pick.hidden = true; fr.kind = ''; } });
    bayWide();
  }
  // With the metro on, the card speaks for the whole Bay: the eyebrow, a shorter intro (one sentence on a phone), and
  // the credits folded into "Data & credits" with the non-affiliation lines always visible. Originals are kept for the
  // teardown (Metro.fail) and #metro=0 never gets here.
  const ORIG = [];
  function swap(el, html) { if (!el) return; ORIG.push([el, el.innerHTML]); el.innerHTML = html; }
  function bayWide() {
    swap(document.querySelector('#title .krow .kicker'), 'An unofficial Bay Area rail &amp; flight simulator');
    swap(document.querySelector('#title p.lede'), `<span class="full">A photoreal replica of the Bay Area's railways, running live on the real timetables: the Peninsula line from 4th&nbsp;&amp;&nbsp;King to Gilroy and all five metro lines, from Antioch to SFO. Ride, drive, explore, or fly real aircraft from 28,000&nbsp;airports.</span><span class="short">The Bay Area's railways, live on the real timetables, and real aircraft from 28,000&nbsp;airports.</span>`);
    // the four modes are the Peninsula line's and the air's: say so where the metro strip offers its own Ride and Drive
    swap(document.querySelector('#title .mode[data-go="ride"] small'), 'Catch the next real Peninsula departure, walk the train, grab a window seat.');
    swap(document.querySelector('#title .mode[data-go="drive"] small'), 'Take the cab of a Peninsula train. Keep time, stop on the mark.');
    const foot = document.querySelector('#title .foot > span');
    if (foot) {
      const t = foot.innerHTML, pen = 'Unofficial. Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board.', air = 'Aircraft types named for identification only; not affiliated with any manufacturer or airline.';
      const data = t.replace(pen, '').replace(air, '').trim() + ' Metro: timetable GTFS and GTFS-Realtime; track and stations © OpenStreetMap contributors.';
      swap(foot, `Unofficial. Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board, or with the San Francisco Bay Area Rapid Transit District. ${air} <details><summary>Data &amp; credits</summary><div>${data}</div></details>`);
    }
  }
  function restoreCard() { for (const [el, html] of ORIG.splice(0).reverse()) el.innerHTML = html; }
  function go(opts) { if (window.__bayline && window.__bayline.start) window.__bayline.start('metro', opts); else front(opts); }
  function openPick(kind) {
    fr.kind = kind; fr.pick.hidden = false; fr.input.value = '';
    fr.input.parentNode.hidden = kind !== 'ride'; fr.input.placeholder = 'Find a station: Embarcadero, SFO, 12th St, Berryessa…';
    renderPick(); if (kind === 'ride') setTimeout(() => fr.input.focus(), 30);
  }
  function renderPick() {
    if (!fr || !fr.kind) return;
    if (fr.kind === 'drive') {
      fr.opts.innerHTML = MetroMissions.defs().filter(m => m.drive).map(m => `<button class="chip" data-mf="mission" data-id="${m.id}">${esc(m.title)}</button>`).join('') + `<button class="chip" data-mf="map">Any train, from the map</button><button class="chip" data-mf="back">Back</button>`;
      fr.hint.textContent = 'Automatic (ATO) by default: W at the departure time. S brakes and switches to manual; ATC keeps you under the speed code.';
      return;
    }
    if (!ready()) { fr.opts.innerHTML = ''; fr.hint.textContent = 'Loading the stations…'; if (on()) MetroSim.init().then(() => renderPick()); return; }
    const q = fr.input.value.trim(), L = q ? findStations(q, 10) : RIDE_PICKS.map(id => MetroSim.stById.get(id)).filter(Boolean);
    fr.opts.innerHTML = L.map(st => `<button class="chip" data-mf="st" data-id="${st.id}">${[...st.lines].filter(l => l !== 'ebart').slice(0, 4).map(l => `<i style="background:${MetroSim.lineColor(l)}"></i>`).join('')}${esc(st.name)}</button>`).join('') || '<span class="hint">No station by that name</span>';
    fr.hint.textContent = q ? '' : 'Or type any of the 50 stations. You start on its platform as the next train pulls in.';
  }
  // what the front door's choices do once the game is running (waits for the metro to load if it hasn't yet)
  function front(o = {}) {
    if (!on()) return;
    const run = () => {
      if (o.action === 'ride' && o.station) {
        const S = MetroSim.stById.get(o.station);
        if (!S || !MetroPlay.teleport(o.station)) { openMap(); return; }
        const now = Env.time.sec, ev = MetroSim.arrivals(o.station, now, 24).find(e => e.dep > now + 3);
        if (ev) { const inf = MetroSim.eventInfo(ev), m = Math.max(0, Math.round((ev.t - now) / 60));
          UI.toast(`${S.name}: the ${inf.lineName} to ${inf.dest} ${m <= 0 ? 'is here' : 'arrives in ' + m + ' min'}. Press E at an open door to board · B arrivals · N the system map.`, 8); }
        else UI.toast(`${S.name}: no more trains today. N opens the system map.`, 6);
      } else if (o.action === 'drive' && o.mission) {
        const m = MetroMissions.defs().find(x => x.id === o.mission); if (m) MetroMissions.start(m); else openMap();
      } else { openMap(); UI.toast('Bayline Metro: click a station to go there, a train to follow it. N reopens this map.', 7); }
    };
    if (ready()) run(); else { UI.toast('Bayline Metro is loading…', 3); MetroSim.init().then(ok => { if (ok && ready()) run(); }); }
  }
  // station search over the names, short names, codes and aliases (the stations' own, plus a few common ones)
  const ALIASES = { SFIA: ['SFO', 'San Francisco Airport'], OAKL: ['OAK', 'Oakland Airport'], CIVC: ['UN Plaza', 'Civic Center/UN Plaza'], BERY: ['North San Jose', 'Berryessa/North San José'],
    '12TH': ['Oakland City Center', 'Downtown Oakland'], '19TH': ['Uptown'], MONT: ['Financial District'], POWL: ['Union Square'], EMBR: ['Ferry Building'], COLS: ['Oakland Coliseum'], DBRK: ['UC Berkeley'] };
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\bst\b\.?/g, 'street').replace(/[^a-z0-9]+/g, ' ').trim();
  function findStations(q, n = 8) {
    const nq = norm(q); if (!nq) return [];
    const out = [];
    for (const st of MetroSim.stations) {
      if (st.id === 'PITT-T') continue;                          // (the shuttle's transfer platform: part of Pittsburg / Bay Point)
      const names = [st.name, st.short, st.id, ...((st.src && st.src.aliases) || []), ...(ALIASES[st.id] || [])].map(norm);
      let best = 0;
      for (const nm of names) best = Math.max(best, nm === nq ? 4 : nm.startsWith(nq) ? 3 : nm.split(' ').some(w => w.startsWith(nq)) ? 2 : nm.includes(nq) ? 1 : 0);
      if (best) out.push([best, st]);
    }
    return out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, n).map(x => x[1]);
  }
  // the HUD's map button (next to Fly): the system map, N on the keyboard
  function hudButton() {
    const tr = document.querySelector('#hud .tr'), fly = document.getElementById('hfly'); if (!tr || document.getElementById('hmetro')) return;
    const b = document.createElement('button'); b.className = 'pill panel'; b.id = 'hmetro'; b.dataset.metroUi = ''; b.title = 'Bayline Metro system map (N)';
    b.innerHTML = `${bars(16, 12, 1.5)}Metro`;
    b.addEventListener('click', () => { const was = api.mapOpen; if (typeof UI !== 'undefined') UI.closeAll(); if (!was) openMap(); });
    if (fly && fly.parentNode === tr) tr.insertBefore(b, fly); else tr.prepend(b);
    el.hbtn = b;
  }

  // ---------------------------------------------------------------- schematic layout (our own diagram, octilinear)
  const SCH = {
    // Richmond branch (NW of MacArthur), the Oakland core, the wye
    RICH: [12.0, 1.0, 'l'], DELN: [12.8, 1.8, 'l'], PLZA: [13.6, 2.6, 'l'], NBRK: [14.4, 3.4, 'l'], DBRK: [15.2, 4.2, 'l'], ASHB: [16.0, 5.0, 'l'],
    MCAR: [16.0, 6.0, 'l'], '19TH': [16.0, 7.0, 'r'], '12TH': [16.0, 8.0, 'r'], WOAK: [14.4, 9.6, 'b'], LAKE: [16.0, 9.6, 'r'],
    // San Francisco and the Peninsula
    EMBR: [11.6, 9.6, 'a'], MONT: [10.8, 10.4, 'r'], POWL: [10.0, 11.2, 'r'], CIVC: [9.2, 12.0, 'r'], '16TH': [8.4, 12.8, 'r'], '24TH': [7.6, 13.6, 'r'],
    GLEN: [6.8, 14.4, 'r'], BALB: [6.0, 15.2, 'r'], DALY: [5.2, 16.0, 'r'], COLM: [5.2, 16.9, 'r'], SSAN: [5.2, 17.8, 'r'], SBRN: [5.2, 18.7, 'r'],
    SFIA: [4.3, 19.6, 'l'], MLBR: [5.2, 20.5, 'r'],
    // East Bay south, the airport connector, Dublin
    FTVL: [16.8, 10.4, 'r'], COLS: [17.6, 11.2, 'r'], OAKL: [16.8, 12.0, 'l'], SANL: [18.4, 12.0, 'r'], BAYF: [19.2, 12.8, 'l'],
    HAYW: [19.2, 13.7, 'r'], SHAY: [19.2, 14.6, 'r'], UCTY: [19.2, 15.5, 'r'], FRMT: [19.2, 16.4, 'r'], WARM: [19.2, 17.3, 'r'], MLPT: [19.2, 18.2, 'r'], BERY: [19.2, 19.1, 'r'],
    CAST: [20.6, 12.8, 'b'], WDUB: [22.0, 12.8, 'a'], DUBL: [23.4, 12.8, 'b'],
    // Concord line and the Antioch shuttle
    ROCK: [17.0, 5.0, 'a'], ORIN: [18.2, 5.0, 'b'], LAFY: [19.4, 5.0, 'a'], WCRK: [20.6, 5.0, 'b'], PHIL: [21.4, 4.2, 'br'], CONC: [22.2, 3.4, 'br'],
    NCON: [23.0, 2.6, 'br'], PITT: [23.8, 1.8, 'br'], PCTR: [24.6, 1.0, 'br'], ANTC: [25.4, 0.2, 'br'] };
  // line segments (unordered station pairs) from the timetable's patterns; the order of strands on a shared segment
  let segs = null;                                           // key 'A|B' -> { a, b, lines: [...] }
  function buildSegs() {
    segs = new Map(); const MN = MetroSim.net;
    for (const p of Object.values(MN.patterns)) for (const L of p.legs) {
      const line = L.sys === 'ebart' ? 'ebart' : p.line;
      for (let i = 0; i < L.stops.length - 1; i++) {
        const a = L.stops[i].station.replace('-T', ''), b = L.stops[i + 1].station.replace('-T', ''); if (a === b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a; let s = segs.get(k); if (!s) segs.set(k, s = { a: a < b ? a : b, b: a < b ? b : a, lines: [] });
        if (!s.lines.includes(line)) s.lines.push(line);
      }
    }
    for (const s of segs.values()) s.lines.sort((x, y) => LINE_ORDER.indexOf(x) - LINE_ORDER.indexOf(y));
  }

  // ---------------------------------------------------------------- the map (both views share pan/zoom)
  const map = { view: 'schematic', drag: null, sel: null, hover: null, geo: { cx: 0, cz: 0, scale: 0.012 }, sch: { cx: 15.45, cz: 10.75, scale: 30 } };
  function setView(v) {
    map.view = v; el.mview.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }
  function V() { return map.view === 'geo' ? map.geo : map.sch; }
  function initMap() {
    const c = el.msysc; c.style.touchAction = 'none';
    // zoom about a screen point (px in canvas pixels) by k
    const zoomAt = (mx, my, k) => { const v = V(), wx = v.cx + (mx - c.width / 2) / v.scale, wz = v.cz + (my - c.height / 2) / v.scale;
      v.scale = U.clamp(v.scale * k, map.view === 'geo' ? 0.0015 : 8, map.view === 'geo' ? 0.6 : 160); v.cx = wx - (mx - c.width / 2) / v.scale; v.cz = wz - (my - c.height / 2) / v.scale; };
    const cpx = (e) => { const r = c.getBoundingClientRect(), dpr = devicePixelRatio; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    c.addEventListener('wheel', (e) => { e.preventDefault(); const [mx, my] = cpx(e); zoomAt(mx, my, e.deltaY > 0 ? 0.87 : 1.15); }, { passive: false });
    // pointers: one drags the map (a tap selects), two pinch-zoom (touch screens)
    const pts = new Map(); let pinch = 0;
    c.addEventListener('pointerdown', (e) => { try { c.setPointerCapture(e.pointerId); } catch (err) { /* (not an active pointer) */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { map.drag = { x: e.clientX, y: e.clientY, moved: 0 }; c.style.cursor = 'grabbing'; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); if (map.drag) map.drag.moved = 99; } });
    c.addEventListener('pointermove', (e) => {
      if (!el.sys || el.sys.hidden) return;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y); const [mx, my] = cpx({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }); zoomAt(mx, my, d / pinch); pinch = d; return; }
      if (map.drag && pts.size === 1) { const v = V(), dx = e.clientX - map.drag.x, dy = e.clientY - map.drag.y; map.drag.moved += Math.abs(dx) + Math.abs(dy); map.drag.x = e.clientX; map.drag.y = e.clientY; v.cx -= dx * devicePixelRatio / v.scale; v.cz -= dy * devicePixelRatio / v.scale; }
      else if (e.pointerType === 'mouse') { map.hover = pick(e); c.style.cursor = map.hover ? 'pointer' : 'grab'; }
    });
    const up = (e) => { const had = pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (!had || pts.size) return;
      if (!map.drag) return; const click = map.drag.moved < (e.pointerType === 'mouse' ? 5 : 12); map.drag = null; c.style.cursor = 'grab'; if (click && el.sys && !el.sys.hidden) { const h = pick(e); if (h) select(h); } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = 0; map.drag = null; });
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !map.drag) map.hover = null; });
  }
  // screen position of a station / a world point in the current view
  function stXY(id, c) {
    const v = V();
    if (map.view === 'geo') { const s = MetroSim.stById.get(id); if (!s) return null; return [(s.x - v.cx) * v.scale + c.width / 2, (s.z - v.cz) * v.scale + c.height / 2]; }
    const p = SCH[id]; if (!p) return null; return [(p[0] - v.cx) * v.scale + c.width / 2, (p[1] - v.cz) * v.scale + c.height / 2];
  }
  function w2s(x, z, c) { const v = map.geo; return [(x - v.cx) * v.scale + c.width / 2, (z - v.cz) * v.scale + c.height / 2]; }
  // where a train sits on the schematic: between the stations of its previous and next stop, by path distance
  function trainXY(tr, c) {
    if (map.view === 'geo') return w2s(tr.x, tr.z, c);
    const S = tr.leg.stops; let k = tr.nextK; if (!(k >= 0) || k >= S.length) k = S.length - 1;
    if (tr.stopK >= 0) { const p = stXY(S[tr.stopK].st.replace('-T', ''), c); return p ? [p[0], p[1], 0] : null; }
    const a = S[Math.max(0, k - 1)], b = S[k]; const pa = stXY(a.st.replace('-T', ''), c), pb = stXY(b.st.replace('-T', ''), c); if (!pa || !pb) return pa || pb;
    const f = U.clamp((tr.s - a.ps) / Math.max(1, b.ps - a.ps), 0, 1); return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, Math.atan2(pb[1] - pa[1], pb[0] - pa[0])];
  }
  function strandOffset(a, b, line, c) {                   // perpendicular offset of a line's strand on a shared segment
    if (!segs) return [0, 0]; const k = a < b ? a + '|' + b : b + '|' + a, s = segs.get(k); if (!s) return [0, 0];
    const i = s.lines.filter(l => !hidden.has(l)).indexOf(line); if (i < 0) return [0, 0];
    const n = s.lines.filter(l => !hidden.has(l)).length, w = lineW(), pa = stXY(s.a, c), pb = stXY(s.b, c); if (!pa || !pb) return [0, 0];
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy) || 1, off = (i - (n - 1) / 2) * w;
    return [-dy / L * off, dx / L * off];
  }
  const lineW = () => Math.max(3, Math.min(9, V().scale * (map.view === 'geo' ? 70 : 0.2))) * devicePixelRatio;
  function pick(e) {
    if (map.view === 'graph') return null;
    const c = el.msysc, r = c.getBoundingClientRect(), dpr = devicePixelRatio, mx = (e.clientX - r.left) * dpr, my = (e.clientY - r.top) * dpr;
    let best = null, bd = (e.pointerType === 'touch' ? 24 : 14) * dpr;
    for (const tr of MetroSim.running) { if (hidden.has(tr.line)) continue; const p = trainXY(tr, c); if (!p) continue; const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd) { bd = d; best = { tr }; } }
    for (const s of MetroSim.stations) { const p = stXY(s.id, c); if (!p) continue; const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd * 0.9) { bd = d; best = { st: s }; } }
    return best;
  }
  function select(h) { map.sel = h; renderSide(); }
  // map imagery for the geographic view (the same NAIP tiles the terrain streams)
  const imgCache = new Map(); let imgUse = 0;
  function tileImg(L, x, y, request) {
    const k = L + '/' + x + '_' + y; let e = imgCache.get(k); if (e) { e.used = ++imgUse; return e.img; }
    if (!request) return null; e = { img: null, used: ++imgUse }; imgCache.set(k, e);
    Stream.image('tiles/img/' + L + '/' + x + '_' + y + '.jpg', 3).then(b => { e.img = b; }, () => {});
    if (imgCache.size > 140) { const old = [...imgCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 40); for (const [kk, v] of old) { if (v.img && v.img.close) v.img.close(); imgCache.delete(kk); } }
    return null;
  }
  function drawGeoBase(g, c) {
    const v = map.geo, W = c.width, H = c.height; if (!Terrain.tiled) return;
    const T0 = Terrain.TILE, px = v.scale; let L = 0; while (L < 8 && Terrain.tileSize(L) * px > 420) L++;
    const T = Terrain.tileSize(L), n = 1 << L, wx0 = v.cx - W / 2 / px, wz0 = v.cz - H / 2 / px, wx1 = v.cx + W / 2 / px, wz1 = v.cz + H / 2 / px;
    const tx0 = Math.max(0, Math.floor((wx0 - T0.X0) / T)), tx1 = Math.min(n - 1, Math.floor((wx1 - T0.X0) / T)), ty0 = Math.max(0, Math.floor((wz0 - T0.Z0) / T)), ty1 = Math.min(n - 1, Math.floor((wz1 - T0.Z0) / T));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      let l = L, x = tx, y = ty, img = null; for (; l >= 0; l--, x >>= 1, y >>= 1) { const im = tileImg(l, x, y, l === L); if (im) { img = im; break; } }
      if (!img) continue; const TL = Terrain.tileSize(l), s = T / TL, IW = img.width || 512, sx = (tx * T - x * TL) / TL * IW, sy = (ty * T - y * TL) / TL * IW;
      const [qx, qy] = w2s(T0.X0 + tx * T, T0.Z0 + ty * T, c); g.drawImage(img, sx, sy, IW * s, IW * s, Math.floor(qx), Math.floor(qy), Math.ceil(T * px) + 1, Math.ceil(T * px) + 1);
    }
    g.fillStyle = 'rgba(8,11,15,0.58)'; g.fillRect(0, 0, W, H);
  }
  const geoPaths = new Map();                               // line -> [Float32Array xz polylines]
  function buildGeoPaths() {
    const MN = MetroSim.net;
    for (const l of MN.lines) { const set = []; const seen = new Set();
      for (const pid of l.patterns || []) { const p = MN.patterns[pid]; if (!p) continue; for (let k = 0; k < p.legs.length; k++) { const P = MetroSim.legPath(pid, k); if (!P) continue; const sig = P.stops[0].station + P.stops[P.stops.length - 1].station + P.length.toFixed(0); if (seen.has(sig)) continue; seen.add(sig); set.push({ xz: P.samples(), line: p.legs[k].sys === 'ebart' ? 'ebart' : l.id }); } }
      geoPaths.set(l.id, set); }
  }
  // station labels: eight spots around each station (right, left, above, below and the four diagonals), offset by the
  // thickness of the line bundle through it; the preferred side first (schematic: SCH's side; geographic: right), then
  // the others. A spot is taken only if its box clears the labels already placed, the station dots and the line bundles
  // (circles of the bundle's half-width every few pixels along each segment); if none is clear, the one with the fewest
  // hits. Interchanges are placed first. Cached per view (scale, centre, size, font, hidden lines).
  let lblKey = '', lblSides = new Map();
  const SPOTS = ['r', 'l', 'a', 'b', 'br', 'al', 'ar', 'bl'];
  function labelAt(sd, p, tw, th, hw, dpr) {
    const g1 = hw + 5 * dpr, dg = hw * 0.72 + 3 * dpr, up = -(hw + 4 * dpr + th / 2), dn = hw + 4 * dpr + th / 2;
    let ax, ay, al;                                                 // text anchor and alignment
    if (sd === 'r') { ax = p[0] + g1; ay = p[1]; al = 'left'; } else if (sd === 'l') { ax = p[0] - g1; ay = p[1]; al = 'right'; }
    else if (sd === 'a') { ax = p[0]; ay = p[1] + up; al = 'center'; } else if (sd === 'b') { ax = p[0]; ay = p[1] + dn; al = 'center'; }
    else { const right = sd[1] === 'r', above = sd[0] === 'a'; ax = p[0] + (right ? dg : -dg); ay = p[1] + (above ? -(dg + th / 2) : dg + th / 2); al = right ? 'left' : 'right'; }
    const x0 = al === 'left' ? ax : al === 'right' ? ax - tw : ax - tw / 2, pad = 2 * dpr;
    return { ax, ay, al, x0: x0 - pad, x1: x0 + tw + pad, y0: ay - th / 2, y1: ay + th / 2 };
  }
  function placeLabels(g, c, fs, dpr) {
    const v = V(), key = [map.view, v.scale.toFixed(6), v.cx.toFixed(3), v.cz.toFixed(3), c.width, c.height, fs, [...hidden].sort().join(',')].join('|');
    if (key === lblKey) return lblSides;
    const geo = map.view === 'geo', W = c.width, H = c.height, lw = lineW(), CS = 48 * dpr;
    // obstacles: circles (dots, bundle samples) in a coarse grid, and the label boxes placed so far
    const grid = new Map(), boxes = [];
    const addC = (x, y, r) => { if (x < -60 || y < -60 || x > W + 60 || y > H + 60) return; const k = Math.floor(x / CS) + ',' + Math.floor(y / CS); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(x, y, r); };
    const hits = (b) => {
      let n = 0; for (const o of boxes) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) n += 3;
      const m = 14 * dpr, gx0 = Math.floor((b.x0 - m) / CS), gx1 = Math.floor((b.x1 + m) / CS), gy0 = Math.floor((b.y0 - m) / CS), gy1 = Math.floor((b.y1 + m) / CS);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) { const a = grid.get(gx + ',' + gy); if (!a) continue;
        for (let i = 0; i < a.length; i += 3) { const dx = Math.max(b.x0 - a[i], 0, a[i] - b.x1), dy = Math.max(b.y0 - a[i + 1], 0, a[i + 1] - b.y1); if (dx * dx + dy * dy < a[i + 2] * a[i + 2]) n++; } }
      return n; };
    const bundle = (pts, w) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (4 * dpr)));
      for (let k = 0; k <= n; k++) addC(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, w); } };
    const hwAt = new Map();                                          // bundle half-width at each station
    if (!geo && segs) for (const sg of segs.values()) { const n = sg.lines.filter(l => !hidden.has(l)).length; if (!n) continue; const a = stXY(sg.a, c), b = stXY(sg.b, c); if (!a || !b) continue;
      const w = (n * lw) / 2 + 1.5 * dpr; bundle([a, b], w); for (const id of [sg.a, sg.b]) hwAt.set(id, Math.max(hwAt.get(id) || 0, (n * lw) / 2)); }
    if (geo) for (const set of geoPaths.values()) for (const P of set) { if (hidden.has(P.line)) continue; const pts = [], A = P.xz, st = Math.max(2, Math.floor(A.length / 2 / 80) * 2);
      for (let i = 0; i < A.length; i += st) pts.push(w2s(A[i], A[i + 1], c)); bundle(pts, lw * 0.35 + 1.5 * dpr); }
    for (const s of MetroSim.stations) { const p = stXY(s.id, c); if (p) addC(p[0], p[1], 7.5 * dpr); }
    lblSides = new Map();
    const order = [...MetroSim.stations].sort((a, b) => b.lines.size - a.lines.size);
    for (const s of order) {
      const p = stXY(s.id, c); if (!p) continue; if (p[0] < -200 || p[1] < -50 || p[0] > W + 200 || p[1] > H + 50) continue;
      const nl = [...s.lines].filter(l => !hidden.has(l)).length; if (!nl && s.lines.size) continue;
      if (geo && v.scale < 0.006 && nl < 2) continue;                // (not labelled at this zoom)
      const pref = geo ? 'r' : (SCH[s.id] || [0, 0, 'r'])[2], tw = g.measureText(s.short).width, hw = Math.max(6.5 * dpr * (geo ? 0.8 : 1), hwAt.get(s.id) || 0);
      let best = null, bn = 1e9;
      for (const sd of [pref, ...SPOTS.filter(q => q !== pref)]) {
        const L = labelAt(sd, p, tw, fs, hw, dpr); let n = hits(L); if (L.x0 < 0 || L.x1 > W || L.y0 < 0 || L.y1 > H) n += 2;
        if (n < bn) { bn = n; best = L; } if (n === 0) break; }
      if (geo && bn > 0) continue;                                    // (geographic: a crowded label waits for a closer zoom; interchanges go first)
      boxes.push(best); lblSides.set(s.id, best);
    }
    lblKey = key; return lblSides;
  }
  // the geographic view opens around you when you are near the metro, else on the whole system
  function fitGeo(c) {
    map.geoFit = false; const cp = Env.camera.position; if (MetroSim.nearestStation(cp, 9000)) return;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const s of MetroSim.stations) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
    if (!(x1 > x0)) return; map.geo.cx = (x0 + x1) / 2; map.geo.cz = (z0 + z1) / 2; map.geo.scale = Math.min(c.width / ((x1 - x0) * 1.1), c.height / ((z1 - z0) * 1.1));
  }
  function draw() {
    const c = el.msysc, g = c.getContext('2d'), W = c.width, H = c.height, dpr = devicePixelRatio;
    g.fillStyle = '#0d1217'; g.fillRect(0, 0, W, H);
    if (!ready()) { g.fillStyle = '#c9c4b8'; g.font = `${14 * dpr}px Barlow, sans-serif`; g.fillText('Loading the metro…', 20 * dpr, 30 * dpr); return; }
    if (map.view === 'graph') { drawGraph(g, c); return; }
    if (!segs) buildSegs();
    const lw = lineW();
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (map.view === 'geo') {
      if (map.geoFit) fitGeo(c);
      drawGeoBase(g, c); if (!geoPaths.size) buildGeoPaths();
      for (const [lid, set] of geoPaths) for (const P of set) { if (hidden.has(P.line)) continue; g.strokeStyle = MetroSim.lineColor(P.line); g.lineWidth = Math.max(2 * dpr, lw * 0.6); g.globalAlpha = 0.9; g.beginPath();
        const a = P.xz; for (let i = 0; i < a.length; i += 2) { const [x, y] = w2s(a[i], a[i + 1], c); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.globalAlpha = 1; }
    } else {
      for (const s of segs.values()) { const pa = stXY(s.a, c), pb = stXY(s.b, c); if (!pa || !pb) continue;
        for (const line of s.lines) { if (hidden.has(line)) continue; const o = strandOffset(s.a, s.b, line, c);
          g.strokeStyle = MetroSim.lineColor(line); g.lineWidth = lw; g.setLineDash(line === 'ebart' ? [lw * 1.2, lw * 0.9] : line === 'grey' ? [lw * 0.6, lw * 0.6] : []);
          g.beginPath(); g.moveTo(pa[0] + o[0], pa[1] + o[1]); g.lineTo(pb[0] + o[0], pb[1] + o[1]); g.stroke(); } }
      g.setLineDash([]);
    }
    // stations
    const fs = Math.max(10, Math.min(15, V().scale * (map.view === 'geo' ? 900 : 0.42))) * dpr;
    g.font = `600 ${fs}px Barlow, sans-serif`; g.textBaseline = 'middle';
    const sides = placeLabels(g, c, fs, dpr);
    for (const s of MetroSim.stations) {
      const p = stXY(s.id, c); if (!p) continue; const nl = [...s.lines].filter(l => !hidden.has(l)).length; if (!nl && s.lines.size) continue;
      const r = (nl > 1 ? 6.5 : 5) * dpr * (map.view === 'geo' ? 0.8 : 1), sel = map.sel && map.sel.st === s, hov = map.hover && map.hover.st === s;
      g.fillStyle = '#f3efe6'; g.strokeStyle = '#0d1217'; g.lineWidth = 2.2 * dpr; g.beginPath(); g.arc(p[0], p[1], r + (sel || hov ? 2 * dpr : 0), 0, 7); g.fill(); g.stroke();
      const L = sides.get(s.id) || ((sel || hov) ? labelAt('r', p, g.measureText(s.short).width, fs, r, dpr) : null), label = s.short; if (!L) continue;
      g.fillStyle = sel ? '#ffffff' : 'rgba(243,239,230,.86)'; g.textAlign = L.al;
      g.lineWidth = 3.5 * dpr; g.strokeStyle = 'rgba(13,18,23,.9)'; g.strokeText(label, L.ax, L.ay); g.fillText(label, L.ax, L.ay);
    }
    g.textAlign = 'left';
    // live trains
    let n = 0;
    for (const tr of MetroSim.running) {
      if (hidden.has(tr.line)) continue; const p = trainXY(tr, c); if (!p) continue; n++;
      let [x, y] = p; if (map.view !== 'geo') { const S = tr.leg.stops, k = Math.max(1, Math.min(S.length - 1, tr.nextK || 1)); const o = strandOffset(S[k - 1].st.replace('-T', ''), S[k].st.replace('-T', ''), tr.line, c); x += o[0]; y += o[1]; }
      const ang = map.view === 'geo' ? Math.atan2(tr.hz, tr.hx) : (p[2] || 0), sz = (tr.key === (Player.focus || '') ? 8 : 6) * dpr;
      g.save(); g.translate(x, y); g.rotate(ang);
      g.fillStyle = MetroSim.lineColor(tr.line); g.strokeStyle = tr.driven ? '#ff5a3c' : '#0d1217'; g.lineWidth = (tr.driven ? 3 : 2) * dpr;
      g.beginPath(); g.moveTo(sz * 1.25, 0); g.lineTo(-sz * 0.8, sz * 0.85); g.lineTo(-sz * 0.8, -sz * 0.85); g.closePath(); g.fill(); g.stroke(); g.restore();
      if ((map.hover && map.hover.tr === tr) || (map.sel && map.sel.tr === tr)) { g.fillStyle = '#fff'; g.font = `600 ${12 * dpr}px "IBM Plex Mono", monospace`; g.fillText(`${MetroSim.termName(tr)} · ${Math.round(tr.v / MPH)} mph`, x + 12 * dpr, y - 10 * dpr); g.font = `600 ${fs}px Barlow, sans-serif`; }
    }
    // you
    if (map.view === 'geo') { const cp = Env.camera.position, [x, y] = w2s(cp.x, cp.z, c); g.strokeStyle = '#ff5a3c'; g.lineWidth = 2.5 * dpr; g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); }
    else { const ms = MetroSim.nearestStation(Env.camera.position, 1500); if (ms) { const p = stXY(ms.id, c); if (p) { g.strokeStyle = '#ff5a3c'; g.lineWidth = 2.5 * dpr; g.beginPath(); g.arc(p[0], p[1], 12 * dpr, 0, 7); g.stroke(); } } }
    el.mfoot.textContent = `${n} trains running · ${Env.clockText(Env.time.sec)} ${Env.time.live && Env.time.scale === 1 ? '(live)' : ''}${typeof MetroLive !== 'undefined' && MetroLive.on ? ' · live predictions' : ''}`;
  }

  // ---------------------------------------------------------------- the train graph (time-distance, "string" chart)
  // Time runs left to right (30 min back, 90 min ahead), the line's stations top to bottom in the order of its
  // busiest pattern; every trip of the line is a line through its (smoothed) arrival and departure times, so headways,
  // dwells, turnbacks at the terminals and the SFO reversal are all visible at once; the live trains ride on it.
  let graphLine = 'yellow';
  const graphCache = { line: '', order: null };
  function graphOrder(lineId) {
    if (graphCache.line === lineId) return graphCache.order;
    const MN = MetroSim.net, L = MN.lineById[lineId === 'ebart' ? 'yellow' : lineId]; if (!L) return null;
    let best = null; for (const pid of L.patterns) { const p = MN.patterns[pid]; if (p && p.dir === 1 && (!best || p.trips > best.trips)) best = p; }
    if (!best) return null;
    const ids = []; for (const Lg of best.legs) for (const s of Lg.stops) { const id = s.station.replace('-T', ''); if (ids[ids.length - 1] !== id) ids.push(id); }
    // stations other patterns add (the SFO wye, Millbrae) go after the nearest listed one
    for (const pid of L.patterns) for (const Lg of MN.patterns[pid].legs) for (let i = 0; i < Lg.stops.length; i++) { const id = Lg.stops[i].station.replace('-T', ''); if (!ids.includes(id)) { const prev = i ? Lg.stops[i - 1].station.replace('-T', '') : null; const at = prev ? ids.indexOf(prev) : -1; ids.splice(at >= 0 ? at + 1 : ids.length, 0, id); } }
    const order = new Map(ids.map((id, i) => [id, i])); graphCache.line = lineId; graphCache.order = { ids, order };
    return graphCache.order;
  }
  function drawGraph(g, c) {
    const W = c.width, H = c.height, dpr = devicePixelRatio, now = Env.time.sec;
    const O = graphOrder(graphLine); if (!O) return;
    const left = 150 * dpr, right = 18 * dpr, top = 34 * dpr, bot = 24 * dpr, t0 = now - 1800, t1 = now + 5400;
    const X = (t) => left + (t - t0) / (t1 - t0) * (W - left - right), Y = (i) => top + i / Math.max(1, O.ids.length - 1) * (H - top - bot);
    const col = MetroSim.lineColor(graphLine);
    // grid: stations, 10-minute ticks
    g.font = `${11 * dpr}px Barlow, sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'right';
    O.ids.forEach((id, i) => { const y = Y(i); g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.beginPath(); g.moveTo(left, y); g.lineTo(W - right, y); g.stroke(); g.fillStyle = 'rgba(243,239,230,.72)'; g.fillText(MetroSim.stName(id), left - 8 * dpr, y); });
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let t = Math.ceil(t0 / 600) * 600; t <= t1; t += 600) { const x = X(t); g.strokeStyle = t % 3600 === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(x, top - 6 * dpr); g.lineTo(x, H - bot); g.stroke(); g.fillStyle = 'rgba(243,239,230,.55)'; g.fillText(Env.clockText(t).replace(' ', '\u202f'), x, 8 * dpr); }
    // every trip of the line in the window (clipped to the plot: the station names stay readable)
    g.save(); g.beginPath(); g.rect(left, top - 12 * dpr, W - left - right, H - top - bot + 12 * dpr); g.clip();
    g.lineWidth = 1.6 * dpr; g.lineJoin = 'round';
    for (const p of MetroSim.plans) {
      if (p.tEnd < t0 || p.tStart > t1) continue;
      for (const l of p.legs) { if ((l.line === 'ebart' ? 'yellow' : l.line) !== graphLine) continue;
        g.strokeStyle = l.stops[l.stops.length - 1].ps > l.stops[0].ps && p.trip.dir === 0 ? col : col; g.globalAlpha = p.trip.dir ? 0.9 : 0.55;
        g.beginPath(); let started = false;
        for (const s of l.stops) { const i = O.order.get(s.st.replace('-T', '')); if (i === undefined) continue; const y = Y(i);
          for (const t of [s.tArr, s.tDep]) { const x = X(t); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); } }
        g.stroke(); } }
    g.globalAlpha = 1;
    // now, and the trains running (interpolated between their stops)
    const xn = X(now); g.strokeStyle = '#ff5a3c'; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(xn, top - 10 * dpr); g.lineTo(xn, H - bot); g.stroke();
    for (const tr of MetroSim.running) { if ((tr.line === 'ebart' ? 'yellow' : tr.line) !== graphLine) continue; const S = tr.leg.stops;
      let y; if (tr.phase !== 'run' && tr.stopK >= 0) { const i = O.order.get(S[tr.stopK].st.replace('-T', '')); if (i === undefined) continue; y = Y(i); }
      else { const a = S[Math.max(0, tr.nextK - 1)], b = S[tr.nextK]; if (!b) continue; const ia = O.order.get(a.st.replace('-T', '')), ib = O.order.get(b.st.replace('-T', '')); if (ia === undefined || ib === undefined) continue; const f = U.clamp((tr.s - a.ps) / Math.max(1, b.ps - a.ps), 0, 1); y = Y(ia + (ib - ia) * f); }
      g.fillStyle = tr.driven ? '#ff5a3c' : '#ffffff'; g.beginPath(); g.arc(xn, y, (tr.key === Player.focus ? 5.5 : 4) * dpr, 0, 7); g.fill(); }
    g.restore();
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = col; g.font = `600 ${13 * dpr}px Barlow, sans-serif`;
    g.fillText(MetroSim.lineName(graphLine) + ' · pick a line with the chips above', left, H - 10 * dpr);
  }

  // ---------------------------------------------------------------- side panel: station or train
  function nextTrainsHtml(stId, n = 8, cls = '') {
    const now = Env.time.sec, rows = MetroSim.arrivals(stId, now, 40).filter(ev => !hidden.has(ev.leg.line)).slice(0, n);
    if (!rows.length) return `<div style="color:var(--ink-dim)">No more trains today.</div>`;
    return rows.map((ev, i) => { const inf = MetroSim.eventInfo(ev), m = Math.round((ev.t - now) / 60);
      return `<div class="mrow ${cls}" data-ev="${i}"><span class="mbar" style="background:${inf.color}"></span><span class="d">${esc(inf.dest)}<small>${esc(MetroSim.lineName(inf.line))} · ${carsText(inf.cars, inf.kind)}${inf.change ? ' · change for ' + esc(inf.change) : ''}${inf.platform ? ' · platform ' + esc(inf.platform) : ''}</small></span><span class="t"><b>${m <= 0 ? 'now' : m + ' min'}</b><br>${Env.clockText(ev.pub)}</span></div>`; }).join('');
  }
  // the network in one phrase, the same on the title strip and the map: the five lines, plus the airport connector
  // (the Antioch shuttle is part of the Yellow Line's service, not a line of its own)
  function linesText() {
    const L = typeof MetroSim !== 'undefined' && MetroSim.lines && MetroSim.lines.length ? MetroSim.lines : null;
    if (!L) return '5 lines + airport connector';
    const n = L.filter(l => l.id !== 'ebart' && l.id !== 'grey').length;
    return `${n} lines${L.some(l => l.id === 'grey') ? ' + airport connector' : ''}`;
  }
  function renderSide() {
    const S = el.mside, h = map.sel;
    if (!h) { S.innerHTML = `<h3>Bayline Metro</h3><div class="sub">${linesText()} · ${MetroSim.stations.filter(x => x.id !== 'PITT-T').length} stations · ${Math.round(131.4)} route miles</div>
      ${MetroSim.lines.filter(l => !['ebart'].includes(l.id)).map(l => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)"><i style="width:8px;height:22px;border-radius:3px;background:${l.color}"></i><span><b>${esc(l.name)}</b><br><small style="color:var(--ink-dim)">${esc(l.terminals.join(' – '))}</small></span></div>`).join('')}
`; return; }
    if (h.st) {
      const s = h.st; S.innerHTML = `<div class="kicker">${esc(stationType(s))}</div><h3>${esc(s.name)}</h3><div class="sub">${[...s.lines].filter(l => l !== 'ebart').map(l => `<span class="mchip"><i style="background:${MetroSim.lineColor(l)}"></i>${esc(MetroSim.lineById.get(l) ? MetroSim.lineById.get(l).short : l)}</span>`).join(' ')}</div>
        <div style="display:flex;gap:8px;margin:6px 0 10px"><button class="btn primary" id="mgo">Go to the platform</button><button class="btn" id="mbd">Arrivals</button></div>${nextTrainsHtml(s.id, 9)}`;
      $('mgo').onclick = () => { closeAll(); MetroPlay.teleport(s); };
      $('mbd').onclick = () => openBoard(s.id);
      const rows = MetroSim.arrivals(s.id, Env.time.sec, 40).filter(ev => !hidden.has(ev.leg.line)).slice(0, 9);
      S.querySelectorAll('.mrow').forEach(r => r.addEventListener('click', (e) => { const ev = rows[+r.dataset.ev]; closeAll(); if (e.shiftKey) drive(ev); else ride(ev); }));
    } else if (h.tr) {
      const tr = MetroSim.trainByKey(h.tr.key) || h.tr, S2 = tr.leg.stops, ns = S2[tr.nextK];
      S.innerHTML = `<div class="kicker">${esc(MetroSim.lineName(tr.line))}</div><h3>${esc(MetroSim.termName(tr))}</h3><div class="sub">${carsAdj(tr.cars, tr.kind)} ${tr.kind === 'dmu' ? 'diesel shuttle' : tr.kind === 'apm' ? 'cable train' : 'train'} · ${Math.round(tr.v / MPH)} mph · ${tr.phase === 'run' ? 'next ' + esc(ns ? MetroSim.stName(ns.st) : '') : tr.stationId ? 'at ' + esc(MetroSim.stName(tr.stationId)) : ''}${tr.plan && tr.plan.live ? ' · live' : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px"><button class="btn primary" id="mfo">Follow</button><button class="btn" id="mcb">Cab view</button>${tr.kind === 'bart' ? '<button class="btn" id="mdr">Drive from the next stop</button>' : ''}</div>
        <div style="font-size:13px;color:var(--ink-dim)">${S2.slice(Math.max(0, tr.nextK || 0)).map(s => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line)"><span>${esc(MetroSim.stName(s.st))}</span><span style="font-family:var(--mono)">${Env.clockText(s.tArr)}</span></div>`).join('')}</div>`;
      $('mfo').onclick = () => { closeAll(); Player.setFocus(tr.key); Player.setMode('chase'); UI.toast('Following the ' + MetroSim.lineName(tr.line) + ' to ' + MetroSim.termName(tr), 4); };
      $('mcb').onclick = () => { closeAll(); Player.setFocus(tr.key); Player.setMode('cab'); };
      const dr = $('mdr'); if (dr) dr.onclick = () => { closeAll(); const k = Math.max(0, Math.min(S2.length - 2, tr.phase === 'run' ? tr.nextK : tr.stopK)); MetroATC.start(tr.plan, { station: S2[k].st }); };
    }
  }
  function stationType(s) { return ({ subway: 'Subway station', aerial: 'Aerial station', surface: 'Surface station', median: 'Freeway median station', trench: 'Station in a cutting' })[s.type] || 'Station'; }
  function search(q) {
    q = q.trim().toLowerCase(); if (!q) { el.mres.hidden = true; return; }
    const L = findStations(q, 8);
    el.mres.innerHTML = L.map(s => `<button data-id="${s.id}">${esc(s.name)}</button>`).join('') || '<button disabled>No station</button>'; el.mres.hidden = false;
    el.mres.querySelectorAll('button[data-id]').forEach(b => b.addEventListener('click', () => { const s = MetroSim.stById.get(b.dataset.id); el.mres.hidden = true; el.msearch.value = ''; focusStation(s); select({ st: s }); }));
  }
  function focusStation(s) { if (map.view === 'geo') { map.geo.cx = s.x; map.geo.cz = s.z; map.geo.scale = Math.max(map.geo.scale, 0.05); } else { const p = SCH[s.id]; if (p) { map.sch.cx = p[0]; map.sch.cz = p[1]; } } }
  function renderLines() {
    el.mlines.innerHTML = MetroSim.lines.filter(l => l.id !== 'ebart').map(l => `<button class="mchip${hidden.has(l.id) ? ' off' : ''}" data-l="${l.id}"><i style="background:${l.color}"></i>${esc(l.short)}</button>`).join('');
    el.mlines.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { const id = b.dataset.l;
      if (map.view === 'graph') { graphLine = id; hidden.delete(id); renderLines(); return; }
      if (hidden.has(id)) { hidden.delete(id); if (id === 'yellow') hidden.delete('ebart'); } else { hidden.add(id); if (id === 'yellow') hidden.add('ebart'); } renderLines(); renderSide(); }));
  }
  function openMap(opts = {}) {
    build(); if (!on()) return;
    if (typeof UI !== 'undefined') UI.closeAll(); closeAll(); el.sys.hidden = false; if (typeof Player !== 'undefined') Player.releaseLock();
    const c = el.msysc, r = c.getBoundingClientRect(); c.width = Math.max(200, r.width * devicePixelRatio); c.height = Math.max(200, r.height * devicePixelRatio);
    if (!map.opened) { map.opened = true; map.sch.scale = Math.min(c.width / 24.5, c.height / 22.4); map.sch.cx = 15.45; map.sch.cz = 10.3; const cp = Env.camera.position; map.geo.cx = cp.x; map.geo.cz = cp.z; map.geo.scale = Math.min(c.width / 70000, c.height / 60000); map.geoFit = true; }
    if (opts.view) setView(opts.view);
    if (ready()) { renderLines(); const ms = MetroSim.nearestStation(Env.camera.position, 1500); if (!map.sel && ms) map.sel = { st: ms }; renderSide(); }
  }

  // ---------------------------------------------------------------- arrivals board
  let boardSt = null;
  function openBoard(stId) {
    build(); if (!ready()) return;
    if (typeof UI !== 'undefined') UI.closeAll(); closeAll(); boardSt = stId; el.board.hidden = false; if (typeof Player !== 'undefined') Player.releaseLock();
    renderBoard();
  }
  function renderBoard() {
    const s = MetroSim.stById.get(boardSt); if (!s) return;
    el.mbk.innerHTML = `<select id="mbsel" style="background:transparent;color:var(--red);border:none;font:inherit;letter-spacing:inherit;text-transform:uppercase;cursor:pointer">${MetroSim.stations.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${x.id}" ${x.id === s.id ? 'selected' : ''} style="color:#111">${esc(x.name)}</option>`).join('')}</select> · Bayline Metro arrivals`;
    $('mbsel').onchange = (e) => openBoard(e.target.value);
    el.mbt.textContent = s.name; el.mbsub.textContent = stationType(s) + ' · ' + [...s.lines].filter(l => l !== 'ebart').map(l => MetroSim.lineName(l)).join(', ');
    const now = Env.time.sec, all = MetroSim.arrivals(s.id, now, 60, { withLast: true });
    const byPlat = new Map(); for (const ev of all) { const p = (ev.sid || '').split('-')[1] || ''; if (!byPlat.has(p)) byPlat.set(p, []); byPlat.get(p).push(ev); }
    const plats = [...byPlat.keys()].sort();
    const list = [];
    el.mbp.innerHTML = plats.map(p => { const evs = byPlat.get(p).filter(ev => !ev.last).slice(0, 6), first = evs[0];
      const led = first ? (() => { const inf = MetroSim.eventInfo(first), m = Math.round((first.t - now) / 60); return `${inf.cars} CAR ${inf.dest.toUpperCase()} ${m <= 0 ? 'NOW BOARDING' : m + ' MIN'}`; })() : 'NO TRAINS';
      return `<div class="plat"><h4>Platform ${esc(p || '·')}</h4><div class="led">${esc(led)}</div>${evs.map(ev => { list.push(ev); const inf = MetroSim.eventInfo(ev), m = Math.round((ev.t - now) / 60);
        return `<div class="mrow" data-ev="${list.length - 1}"><span class="mbar" style="background:${inf.color}"></span><span class="d">${esc(inf.dest)}<small>${esc(MetroSim.lineName(inf.line))} · ${carsText(inf.cars, inf.kind)}${inf.change ? ' · change for ' + esc(inf.change) : ''}</small></span><span class="t"><b>${m <= 0 ? 'now' : m + ' min'}</b><br>${Env.clockText(ev.pub)}</span></div>`; }).join('') || '<div style="color:var(--ink-dim)">No more trains today.</div>'}</div>`; }).join('');
    el.mbp.querySelectorAll('.mrow').forEach(r => r.addEventListener('click', (e) => { const ev = list[+r.dataset.ev]; closeAll(); if (e.shiftKey) drive(ev); else ride(ev); }));
    // connections: the Peninsula line at Millbrae, bus bridges today
    let conn = '';
    if (s.id === 'MLBR' && typeof Sim !== 'undefined' && Sim.TT) { const si = Sim.TT.stations.indexOf('place_MLBR'); const deps = si >= 0 ? Sim.departures(si, now, 4) : [];
      conn += `<div><b style="color:var(--ink)">Peninsula line connections</b> · ${deps.map(d => `${Env.clockText(d.t)} ${Sim.routeShort(d.trip).toLowerCase()} to ${Sim.TT.names[Sim.TT.stations[d.trip.stops[d.trip.stops.length - 1][0]]]}`).join(' · ') || 'none soon'}</div>`; }
    const bus = busAt(s.id, now); if (bus.length) conn += `<div style="margin-top:6px"><b style="color:var(--ink)">Bus bridge</b> · trains are replaced by buses on part of the line today: ${bus.map(b => Env.clockText(b.t) + ' to ' + b.to).join(' · ')}</div>`;
    el.mbc.innerHTML = conn;
    el.mba.innerHTML = `<button class="btn primary" id="mbgo">Go to the platform</button><button class="btn" id="mbmap">System map</button>${s.id === 'MLBR' ? '<button class="btn" id="mbxf">Transfer to the Peninsula line</button>' : ''}`;
    $('mbgo').onclick = () => { closeAll(); MetroPlay.teleport(s); };
    $('mbmap').onclick = () => { openMap(); map.sel = { st: s }; focusStation(s); renderSide(); };
    const xf = $('mbxf'); if (xf) xf.onclick = () => { closeAll(); MetroPlay.toPeninsula(); };
  }
  function busAt(stId, now) {
    const out = [];
    for (const b of MetroSim.busTodayList()) {
      const i = b.b.stops.findIndex(g => stopStation(g) === stId); if (i < 0 || i >= b.b.stops.length - 1) continue;
      const t = b.b.t[i * 2 + 1] + b.dayOff; if (t < now - 60 || t > now + 3600) continue;
      out.push({ t, to: MetroSim.stName(stopStation(b.b.stops[b.b.stops.length - 1])) });
    }
    return out.sort((a, b) => a.t - b.t).slice(0, 4);
  }
  const stopMap = new Map();
  const stopStation = (gtfs) => { if (!stopMap.size) for (const s of MetroSim.net.stations) for (const p of s.platforms || []) stopMap.set(p.gtfs, s.id); return stopMap.get(gtfs) || ''; };
  // ride: on the right platform ~75 s before the train leaves (it pulls in ~40 s before that); drive: take over there
  function ride(ev) {
    const now = Env.time.sec; if (ev.t - now > 100 || ev.t < now) Env.setClock(ev.t - 75); Env.time.scale = 1;
    MetroPlay.teleport(ev.leg.stops[ev.k].st, ev.sid);
    Player.setFocus(ev.leg.chainKey || ev.plan.key);
    const inf = MetroSim.eventInfo(ev); UI.toast(`Wait for the ${carsAdj(inf.cars, inf.kind)} ${MetroSim.lineName(inf.line)} train to ${inf.dest}; press E at an open door to board`, 6);
  }
  function drive(ev) { if (ev.leg.kind !== 'bart') { UI.toast('That one drives itself: ride it instead'); ride(ev); return; } MetroATC.start(ev.plan, { station: ev.leg.stops[ev.k].st }); }

  // ---------------------------------------------------------------- HUD: ride panel, driver's display, line strip
  let slow = 0, boardT = 0;
  let drivebarMetro = false;
  function update(dt) {
    if (!on()) return; build();
    const mapOn = !!(el.sys && !el.sys.hidden); if (el.hbtn && el.hbtn._on !== mapOn) { el.hbtn._on = mapOn; el.hbtn.classList.toggle('on', mapOn); }
    if (el.sys && !el.sys.hidden) { const c = el.msysc, r = c.getBoundingClientRect(); if (c.width !== Math.round(r.width * devicePixelRatio)) { c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio; } draw(); }
    slow -= dt; if (slow > 0) return; slow = 0.2;
    if (!ready()) { el.ride.hidden = el.dmi.hidden = el.strip.hidden = true; return; }
    if (el.board && !el.board.hidden) { boardT -= 0.2; if (boardT <= 0) { boardT = 5; renderBoard(); } }
    const tr = Player.focusTrain(), metro = tr && tr.metro, D = MetroSim.drive, dm = D && typeof MetroATC !== 'undefined' ? MetroATC.dmi() : null;
    const flying = typeof Flight !== 'undefined' && Flight.active;
    el.dmi.hidden = !dm || flying;
    el.ride.hidden = !(metro && !dm && (Player.mode === 'onboard' || Player.mode === 'cab')) || flying;
    el.strip.hidden = !(metro && (dm || !['walk', 'fly', 'orbit'].includes(Player.mode))) || flying || document.body.classList.contains('photo');
    document.body.classList.toggle('mdriving', !!dm);
    // the on-screen driving buttons (touch) speak metro while you drive a metro train: ATO, no bell, change ends
    if (!!dm !== drivebarMetro) { drivebarMetro = !!dm; const bar = document.getElementById('drivebar');
      if (bar) for (const b of bar.querySelectorAll('button')) {
        if (b.dataset.k === 'KeyA') { b.dataset.pen = b.dataset.pen || b.textContent; b.textContent = dm ? 'ATO' : b.dataset.pen; }
        if (b.dataset.k === 'KeyQ') { b.dataset.pen = b.dataset.pen || b.textContent; b.textContent = dm ? 'Ends' : b.dataset.pen; }
        if (b.dataset.k === 'KeyG') b.hidden = !!dm; } }
    if (dm) renderDmi(dm, tr); else if (!el.ride.hidden) renderRide(tr);
    if (!el.strip.hidden) drawStrip(tr);
    pushBoards();
  }
  function renderRide(tr) {
    const col = MetroSim.lineColor(tr.line), S = tr.leg.stops;
    el.mrc.style.background = col; el.mrl.textContent = MetroSim.lineName(tr.line); { const ch = MetroSim.changeFor(tr); el.mrd.textContent = 'to ' + MetroSim.termName(tr) + (ch ? ' (change for ' + ch + ')' : '') + ' · ' + carsText(tr.cars, tr.kind) + ' · car ' + (Player.ob.car + 1); }
    const atSt = tr.phase !== 'run' && tr.stopK >= 0 ? S[tr.stopK] : null, ns = S[tr.nextK];
    el.mrk.textContent = atSt ? (tr.doorsOpen ? 'Doors open' : 'Now at') : 'Next station';
    el.mrn.textContent = atSt ? MetroSim.stName(atSt.st) : ns ? MetroSim.stName(ns.st) : '—';
    el.mrs.innerHTML = `${Math.round(tr.v / MPH)}<small>mph</small>`;
    const side = ns ? (MetroSim.stopSide(tr.leg, tr.nextK) > 0 ? 'right' : 'left') : '';   // (as you face the direction of travel)
    el.mri.textContent = atSt ? (tr.dwellLeft > 0 ? `Departs in ${Math.max(0, Math.round(tr.dwellLeft))} s` : '') + (tr.phase === 'terminal' ? 'Last stop: everybody off' : '')
      : ns ? `Arriving ${Env.clockText(ns.tArr)}${side ? ' · doors open on the ' + side : ''}` : '';
    drawNextStops(el.mrline, tr);
  }
  // the car's next-stop screen, reduced to a strip: the next five stations on the line colour
  function drawNextStops(c, tr) {
    const r = c.getBoundingClientRect(), dpr = devicePixelRatio; if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d'), W = c.width, H = c.height, S = tr.leg.stops; g.clearRect(0, 0, W, H);
    const k0 = Math.max(0, tr.phase !== 'run' && tr.stopK >= 0 ? tr.stopK : tr.nextK - 1), L = S.slice(k0, k0 + 5), col = MetroSim.lineColor(tr.line);
    const x0 = 16 * dpr, x1 = W - 16 * dpr, y = 22 * dpr; g.strokeStyle = col; g.lineWidth = 6 * dpr; g.lineCap = 'round'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.font = `600 ${11.5 * dpr}px Barlow, sans-serif`; g.textBaseline = 'top';
    L.forEach((s, i) => { const x = L.length > 1 ? x0 + (x1 - x0) * i / (L.length - 1) : x0; g.fillStyle = '#0e1116'; g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.fill(); g.fillStyle = '#f3efe6'; g.beginPath(); g.arc(x, y, 3.6 * dpr, 0, 7); g.fill();
      g.fillStyle = i === (tr.phase === 'run' ? 1 : 0) ? '#fff' : 'rgba(243,239,230,.6)'; g.textAlign = i === 0 ? 'left' : i === L.length - 1 ? 'right' : 'center'; g.fillText(MetroSim.stName(s.st), x + (i === 0 ? -8 * dpr : i === L.length - 1 ? 8 * dpr : 0), y + 12 * dpr); });
    if (tr.phase === 'run' && L.length > 1) { const a = S[k0], b = S[k0 + 1], f = U.clamp((tr.s - a.ps) / Math.max(1, b.ps - a.ps), 0, 1), x = x0 + (x1 - x0) / (L.length - 1) * f; g.fillStyle = '#ff5a3c'; g.beginPath(); g.moveTo(x + 7 * dpr, y); g.lineTo(x - 5 * dpr, y - 6 * dpr); g.lineTo(x - 5 * dpr, y + 6 * dpr); g.fill(); }
    g.textAlign = 'left';
  }
  function renderDmi(d, tr) {
    const v = d.v / MPH, code = d.code / MPH, top = 75;
    el.mds.textContent = Math.round(v); el.mdcv.textContent = code < 0.5 ? 'STOP' : Math.round(code);
    el.mdc.className = 'code' + (d.atc === 'penalty' || d.atc === 'brake' ? ' alarm' : d.atc === 'warn' ? ' warn' : '');
    el.mdg.style.width = Math.min(100, v / top * 100) + '%'; el.mdg.style.background = d.atc === 'ok' ? '#dfe6ee' : d.atc === 'warn' ? '#ffc53d' : '#ff5a4a'; el.mdgb.style.left = Math.min(99, code / top * 100) + '%';
    el.mdm.textContent = d.mode; el.mdm.className = 'pill ' + (d.mode === 'ATO' ? 'ato' : 'man');
    el.mdn.textContent = d.reverse ? 'R ' + d.notch : d.notch; el.mdn.className = 'pill ' + (d.notch === 'EB' ? 'eb' : d.notch[0] === 'P' ? 'p' : d.notch[0] === 'B' ? 'b' : '');
    el.mdd.textContent = d.doors > 0.01 ? (d.doors > 0.99 ? 'DOORS OPEN' : 'DOORS…') : 'DOORS SHUT'; el.mdsc.textContent = Math.round(d.score) + ' pts';
    el.mdgd.textContent = d.guide; el.mdgd.className = 'guide' + (/^(EMERG|PENALTY|ATC BRAKE|BRAKE NOW)/.test(d.guide) ? ' alarm' : /^(OVERSPEED|Start braking|Train ahead)/.test(d.guide) ? ' warn' : '');
    const n = d.next; el.mdns.textContent = n ? n.name : '—'; el.mdto.textContent = n ? (n.togo > 1000 ? (n.togo / 1609.34).toFixed(2) + ' mi' : n.togo.toFixed(1) + ' m') : '—';
    const lm = Math.round(d.late / 60), lt = Math.abs(d.late) < 30 ? 'on time' : (lm > 0 ? '+' + lm : lm < 0 ? '−' + (-lm) : (d.late > 0 ? '+' : '−') + '<1') + ' min';
    el.mdsch.innerHTML = n ? `<span class="${d.late > 60 ? 'late' : d.late < -90 ? 'early' : 'ontime'}">${Env.clockText(n.sched)} (${lt})</span>` : '—';
    el.mdtr.textContent = d.target ? `${d.target.v < 0.5 ? 'stop' : Math.round(d.target.v / MPH) + ' mph'} in ${d.target.dist > 1600 ? (d.target.dist / 1609.34).toFixed(1) + ' mi' : Math.round(d.target.dist * 3.281) + ' ft'}` : d.clear >= 6 ? 'clear' : d.clear + ' circuit' + (d.clear === 1 ? '' : 's') + ' clear';
  }
  function drawStrip(tr) {
    const c = el.mstripc, r = c.getBoundingClientRect(), dpr = devicePixelRatio; if (!tr || !tr.leg) return;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
    const S = tr.leg.stops, L = Math.max(1, S[S.length - 1].ps - S[0].ps), Y = (ps) => (0.04 + 0.92 * (ps - S[0].ps) / L) * H, X = 22 * dpr, col = MetroSim.lineColor(tr.line);
    g.strokeStyle = col; g.lineWidth = 4 * dpr; g.lineCap = 'round'; g.beginPath(); g.moveTo(X, Y(S[0].ps)); g.lineTo(X, Y(S[S.length - 1].ps)); g.stroke();
    g.font = `${10.5 * dpr}px Barlow, sans-serif`; g.textBaseline = 'middle'; let lastY = -1e9;
    for (const s of S) { const y = Y(s.ps); g.fillStyle = '#0e1116'; g.beginPath(); g.arc(X, y, 4.5 * dpr, 0, 7); g.fill(); g.fillStyle = '#f3efe6'; g.beginPath(); g.arc(X, y, 2.6 * dpr, 0, 7); g.fill();
      if (y - lastY > 11 * dpr) { g.fillStyle = 'rgba(243,239,230,.62)'; g.fillText(MetroSim.stName(s.st), X + 14 * dpr, y); lastY = y; } }
    // other trains on the same leg path (same pattern leg) and you
    for (const o of MetroSim.running) { if (o.leg.path !== tr.leg.path || o === tr) continue; const y = Y(o.s); if (y < 0 || y > H) continue; g.fillStyle = MetroSim.lineColor(o.line); g.beginPath(); g.arc(X - 9 * dpr, y, 3 * dpr, 0, 7); g.fill(); }
    const y = Y(tr.s); g.fillStyle = '#ff5a3c'; g.beginPath(); g.moveTo(X - 12 * dpr, y - 6 * dpr); g.lineTo(X - 12 * dpr, y + 6 * dpr); g.lineTo(X - 3 * dpr, y); g.fill();
  }
  // platform displays (stations workstream): the next trains per platform of every station near the camera, every ~5 s
  let pushT = 0;
  function pushBoards() {
    if (typeof MetroStations === 'undefined' || !MetroStations.setBoard) return;
    pushT -= 0.2; if (pushT > 0) return; pushT = 5;
    const cp = Env.camera.position, now = Env.time.sec;
    for (const s of MetroSim.stations) {
      if (Math.hypot(s.x - cp.x, s.z - cp.z) > 1500) continue;
      const byPlat = new Map();
      for (const ev of MetroSim.arrivals(s.id, now, 24)) { const p = (ev.sid || '').split('-')[1] || ''; if (!byPlat.has(p)) byPlat.set(p, []); const L = byPlat.get(p); if (L.length >= 4) continue;
        const inf = MetroSim.eventInfo(ev); L.push({ line: inf.line, color: inf.color, dest: inf.dest, cars: inf.cars, min: Math.max(0, Math.round((ev.t - now) / 60)), trip: ev.plan.trip.id }); }
      for (const [p, rows] of byPlat) { try { MetroStations.setBoard(s.id, p, rows); } catch (e) { /* the stations module decides what it shows */ } }
    }
  }
  // HUD helpers for 66_ui.js
  function whereText(p) {
    if (!ready()) return null;
    const tr = typeof Player !== 'undefined' ? Player.focusTrain() : null;
    if (tr && tr.metro && !['walk', 'fly', 'orbit'].includes(Player.mode)) { const S = tr.leg.stops;
      if (tr.phase !== 'run' && tr.stopK >= 0) return MetroSim.stName(S[tr.stopK].st) + ' · Bayline Metro';
      const a = S[Math.max(0, tr.nextK - 1)], b = S[tr.nextK]; return b ? `Between ${MetroSim.stName(a.st)} and ${MetroSim.stName(b.st)}` : null; }
    const ms = MetroSim.nearestStation(p, 450); if (!ms) return null;
    if (Player.mode === 'walk' && Player.onMetroFloor && Player.onMetroFloor()) return ms.name + ' · Bayline Metro';
    const pen = typeof Stations !== 'undefined' ? Stations.nearest(p, 450) : null;
    if (pen && Math.hypot(pen.x - p.x, pen.z - p.z) < Math.hypot(ms.x - p.x, ms.z - p.z)) return null;
    return ms.name + ' · Bayline Metro';
  }
  // is the camera at a metro station rather than a Peninsula one (the Peninsula line strip steps aside)
  let atT = 0, atV = false;
  function atMetro(p) { const now = performance.now(); if (now - atT < 500) return atV; atT = now;
    if (!ready()) return (atV = false); const ms = MetroSim.nearestStation(p, 700); if (!ms) return (atV = false);
    if (typeof Player !== 'undefined' && Player.mode === 'walk' && Player.onMetroFloor && Player.onMetroFloor()) return (atV = true);
    const pen = typeof Stations !== 'undefined' ? Stations.nearest(p, 700) : null; return (atV = !pen || Math.hypot(ms.x - p.x, ms.z - p.z) < Math.hypot(pen.x - p.x, pen.z - p.z)); }
  // the HUD line at a metro station: the next train of each line and direction, soonest first
  function stationSub(p) {
    const ms = MetroSim.nearestStation(p, 700); if (!ms) return '';
    const now = Env.time.sec, seen = new Set(), out = [];
    for (const ev of MetroSim.arrivals(ms.id, now, 24)) { const inf = MetroSim.eventInfo(ev), k = inf.line + '>' + inf.dest; if (seen.has(k)) continue; seen.add(k);
      const m = Math.max(0, Math.round((ev.t - now) / 60)); out.push(`${MetroSim.lineById.get(inf.line) ? MetroSim.lineById.get(inf.line).short : inf.line} to ${inf.dest} ${m ? m + ' min' : 'now'}`); if (out.length >= 3) break; }
    return out.length ? 'Next: ' + out.join(' · ') : 'No more trains today';
  }
  // train sizes: cars, or units for the Antioch shuttle (each a two-car articulated diesel)
  function carsText(n, kind) { return kind === 'dmu' ? `${n} unit${n > 1 ? 's' : ''}` : `${n} car${n > 1 ? 's' : ''}`; }
  function carsAdj(n, kind) { return kind === 'dmu' ? `${n}-unit` : `${n}-car`; }
  function subText(tr) { const S = tr.leg.stops, ns = S[tr.nextK], ch = MetroSim.changeFor(tr); return `${MetroSim.lineName(tr.line)} to ${MetroSim.termName(tr)}${ch ? ' (change for ' + ch + ')' : ''} · ${carsText(tr.cars, tr.kind)} · ${Math.round(tr.v / MPH)} mph${ns && tr.phase === 'run' ? ' · next ' + MetroSim.stName(ns.st) : tr.stationId ? ' · at ' + MetroSim.stName(tr.stationId) : ''}`; }

  if (typeof Metro !== 'undefined') { const g = Metro.guardAll({ whereText, subText, stationSub, atMetro, openMap, openBoard, ride, drive, front }, 'the metro interface');
    ({ whereText, subText, stationSub, atMetro, openMap, openBoard, ride, drive, front } = g); }
  // (QA) where a station is on screen in the open map, in CSS pixels
  function stationXY(id) { const c = el.msysc; if (!c || el.sys.hidden) return null; const p = stXY(id, c), r = c.getBoundingClientRect(); return p ? { x: r.left + p[0] / devicePixelRatio, y: r.top + p[1] / devicePixelRatio } : null; }
  const api = { build, openMap, openBoard, closeAll, anyOpen, update, whereText, subText, stationSub, atMetro, ride, drive, front, findStations, stationXY, get mapState() { return map; }, get mapOpen() { return !!(el.sys && !el.sys.hidden); }, get boardOpen() { return !!(el.board && !el.board.hidden); } };
  if (typeof window !== 'undefined') { const m = (window.__baylineMods = window.__baylineMods || {}); m.MetroUI = api; window.__MUI = api; }
  return api;
})();

// Bayline Metro missions (J menu, #metro=1): drive runs under ATC, a cross-system commute through the Millbrae transfer,
// and rides on the two odd vehicles (the Antioch shuttle, the airport cable train). Game.missionList() appends these;
// Game.startMission() hands kind 'metro' back here.
const MetroMissions = (() => {
  const on = () => typeof MetroSim !== 'undefined' && MetroSim.enabled && MetroSim.ready;
  let active = null;
  // the next departure from `from` whose next stop is `to` (or whose later stops include it), BART vehicles only
  function nextRun(from, to, after) {
    const t0 = after !== undefined ? after : Env.time.sec;
    for (const ev of MetroSim.arrivals(from, t0 + 45, 120)) { const S = ev.leg.stops; if (ev.leg.kind !== 'bart' || ev.k >= S.length - 1) continue;
      if (S.slice(ev.k + 1).some(s => s.st === to)) return ev;
      for (let x = ev.leg.next; x; x = x.next) if (x.stops.some(s => s.st === to)) return ev; }   // (through a reversal: SFO)
    return null;
  }
  function list() { return on() ? defs() : []; }
  function defs() {
    return [
      { id: 'm-tube', kind: 'metro', tag: 'METRO DRIVE', title: 'Under the Bay', sub: 'West Oakland to Embarcadero through the Transbay Tube, 135 ft under the water. Then Market Street.', drive: ['WOAK', 'EMBR'] },
      { id: 'm-market', kind: 'metro', tag: 'METRO DRIVE', title: 'Market Street', sub: 'Embarcadero to Civic Center in manual: four stations, four berths, 90 seconds apart.', drive: ['EMBR', 'CIVC'], manual: true },
      { id: 'm-hills', kind: 'metro', tag: 'METRO DRIVE', title: 'Berkeley Hills Tunnel', sub: 'Orinda to Rockridge: three miles of tunnel, then the freeway median at 70 mph.', drive: ['ORIN', 'ROCK'] },
      { id: 'm-sfo', kind: 'metro', tag: 'METRO DRIVE', title: 'Airport Reversal', sub: 'San Bruno into SFO, change ends (Q), and on to Millbrae.', drive: ['SBRN', 'MLBR'] },
      { id: 'm-commute', kind: 'metro', tag: 'COMMUTE', title: 'Commuter: The Millbrae Connection', sub: 'Embarcadero to Palo Alto by 9:15 AM: the metro to Millbrae, then change to the Peninsula line.', commute: { from: 'EMBR', to: 'palo_alto', start: 7 * 3600 + 55 * 60, deadline: 9 * 3600 + 15 * 60 } },
      { id: 'm-oak', kind: 'metro', tag: 'RIDE', title: 'The Cable Train', sub: 'Coliseum to the Oakland Airport on the cable-hauled people mover, 30 mph over the flats.', ride: ['COLS', 'OAKL'] },
      { id: 'm-antioch', kind: 'metro', tag: 'RIDE', title: 'The Antioch Shuttle', sub: 'Cross the platform at Pittsburg / Bay Point to the diesel shuttle, down the SR-4 median to Antioch.', ride: ['PITT', 'ANTC'] },
    ];
  }
  function start(m) {
    active = null;
    if (m.drive) {
      const ev = nextRun(m.drive[0], m.drive[1]); if (!ev) { UI.toast('No suitable train in the timetable today'); return; }
      active = { m, kind: 'drive' }; MetroATC.start(ev.plan, { station: m.drive[0], manual: !!m.manual, mission: active, title: m.title });
    } else if (m.commute) {
      const c = m.commute; Env.setClock(c.start); Env.time.scale = 1; MetroPlay.teleport(c.from);
      const pen = typeof Stations !== 'undefined' ? Stations.list.find(s => s.id === c.to) : null;
      active = { m, kind: 'commute', target: pen, deadline: c.deadline, t0: Env.time.sec };
      UI.toast(`${m.title}: get to ${pen ? pen.name : c.to} by ${Env.clockText(c.deadline)}. B for trains, N for the map; at Millbrae press E by the metro platform to change.`, 8);
    } else if (m.ride) {
      const ev = MetroSim.arrivals(m.ride[0], Env.time.sec + 60, 60).find(e => e.k < e.leg.stops.length - 1 && e.leg.stops.slice(e.k + 1).some(s => s.st === m.ride[1]) && (m.ride[0] !== 'PITT' || e.leg.kind === 'dmu' || e.leg.stops[e.k].st === 'PITT-T'))
        || MetroSim.arrivals(m.ride[0] === 'PITT' ? 'PITT-T' : m.ride[0], Env.time.sec + 60, 60).find(e => e.k < e.leg.stops.length - 1 && e.leg.stops.slice(e.k + 1).some(s => s.st === m.ride[1]));
      if (!ev) { UI.toast('No suitable train in the timetable today'); return; }
      active = { m, kind: 'ride', to: m.ride[1], t0: Env.time.sec }; MetroUI.ride(ev);
    }
  }
  function done(mission, ok) { if (active && mission === active) active = null; }
  function update() {
    if (!active || !on()) return;
    const p = Env.camera.position, t = Env.time.sec;
    if (active.kind === 'commute' && active.target) {
      const d = Math.hypot(active.target.x - p.x, active.target.z - p.z);
      if (d < 160 && Player.mode === 'walk') { const early = active.deadline - t, m = active.m; active = null;
        UI.showResult({ kicker: 'Commute', title: early >= 0 ? 'Made the meeting' : 'Late…', score: Math.max(0, Math.round(600 + early / 2)), grade: early > 600 ? 'A' : early >= 0 ? 'B' : 'F',
          lines: [early >= 0 ? `Arrived with ${Math.round(early / 60)} min to spare.` : `Arrived ${Math.round(-early / 60)} min late.`, 'Metro to Millbrae, then the Peninsula line: the same connection real commuters make.'] }); }
      else if (t > active.deadline + 1800) { active = null; UI.toast('Mission failed: too late'); }
    } else if (active.kind === 'ride') {
      const tr = Player.focusTrain();
      if (tr && tr.metro && Player.mode === 'onboard' && tr.stationId === active.to && tr.phase !== 'run') { const mins = (t - active.t0) / 60, m = active.m; active = null;
        UI.showResult({ kicker: 'Ride', title: 'You made it', score: 300, grade: 'A', lines: [`${m.title}: ${Math.round(mins)} minutes from the platform to ${MetroSim.stName(m.ride[1])}.`] }); }
    }
  }
  const api = { list, defs, start, done, update, get active() { return active; } };
  if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroMissions = api;   // (debug handle)
  return api;
})();
