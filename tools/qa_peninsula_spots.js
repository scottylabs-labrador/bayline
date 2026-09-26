// QA (Bayline Metro M3 gate item 2): the Peninsula line's HUD, boards and prompts at its own stations, including the
// spots next to the metro (Millbrae shares a building; San Bruno and South SF are a few km from their metro namesakes;
// 4th & King, Hillsdale and Diridon have no metro). With the metro on or off the answer must be the same: the Caltrain
// station's name on the HUD, a Peninsula train or departures in the sub-line, the Peninsula strip, the Peninsula walk
// prompt, and B opens the Peninsula departures board (never the metro's). Injected with tools/shot.mjs --eval.
// Results: one JSON line per spot + a verdict (window.__spots).
new Promise(ok => { const f = () => window.__bayline && window.__bayline.Sim.TT ? ok() : setTimeout(f, 200); f(); }).then(async () => {
  const B = window.__bayline, P = B.Player, M = B.MetroSim, $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // with the metro on, wait for it to be running (so the metro's HUD logic is live while we check the Peninsula's)
  if (M && M.enabled) for (let i = 0; i < 150 && !M.ready; i++) await sleep(200);
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const spots = (window.__spotsIds || 'san_francisco,south_sf,san_bruno,place_MLBR,hillsdale,sj_diridon').split(',');
  const out = { metro: !!(M && M.enabled && M.ready), spots: [], fails: 0 };
  for (const id of spots) {
    const tr = B.Track.byId[id]; if (!tr) { out.spots.push({ id, error: 'no such station' }); out.fails++; continue; }
    const st = B.Stations.list[tr.idx];
    P.teleportToStation(st, 1); await sleep(3500);
    const where = $('hwhere').textContent, sub = $('hsub').textContent, strip = !$('strip').hidden, prompt = (P.prompt || '').replace(/<[^>]+>/g, '');
    key('KeyB'); await sleep(700);
    const penBoard = !$('board').hidden, metroBoard = !!(B.MetroUI && B.MetroUI.boardOpen), boardTitle = penBoard ? ($('board').querySelector('h2') || {}).textContent || '' : '';
    B.UI.closeAll(); if (B.MetroUI) B.MetroUI.closeAll();
    const r = { id, name: st.name, where, sub, strip, prompt, penBoard, metroBoard, boardTitle };
    const bad = [];
    if (/Bayline Metro/.test(where)) bad.push('HUD place is the metro\'s');
    if (!where.includes(st.name)) bad.push('HUD place is not ' + st.name);
    if (/ Line to |^Next: /.test(sub)) bad.push('HUD sub-line is the metro\'s');
    if (!strip) bad.push('Peninsula strip hidden');
    if (!prompt.includes(st.name + ' departures')) bad.push('walk prompt is not the Peninsula\'s');
    if (id === 'place_MLBR' && out.metro && !/transfer to the metro/.test(prompt)) bad.push('Millbrae: no transfer prompt');
    if (!penBoard || metroBoard) bad.push('B did not open the Peninsula board');
    r.ok = !bad.length; if (bad.length) { r.bad = bad; out.fails++; }
    out.spots.push(r);
  }
  window.__spots = out;
  return JSON.stringify(out);
});
