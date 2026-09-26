// QA (Bayline Metro, M3 gate item 8): a tour of every metro station as a player, in real frames: on each platform (the
// 50 stations, the airport connector's Coliseum and Oakland Airport platforms, the Antioch shuttle's transfer platform
// at Pittsburg / Bay Point and Antioch) the walker is put on the platform as the next train comes in, stays a while
// (the station builds, trains arrive and leave, announcements run), the arrivals board opens and closes. Injected with
// tools/shot.mjs --eval by tools/qa_metro_tour.sh, which fails on any page or console error. window.__dwell (ms) per stop.
new Promise(r => { const f = () => window.__bayline && __bayline.MetroSim && __bayline.MetroSim.ready ? r() : setTimeout(f, 300); f(); }).then(async () => {
  const B = __bayline, M = B.MetroSim, P = B.Player, sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dwell = window.__dwell || 11000;
  const stops = M.stations.filter(s => s.id !== 'PITT-T').map(s => [s.id, undefined]);
  stops.push(['COLS', 'H10'], ['OAKL', 'H40'], ['PITT-T', 'E10-T'], ['PITT-T', 'C80-T'], ['ANTC', undefined]);   // (connector, shuttle)
  const out = [], t0 = performance.now();
  let frames0 = B.Env.renderer.info.render.frame;
  for (const [id, plat] of stops) {
    const ok = !!B.MetroPlay.teleport(id, plat); await sleep(dwell);
    const on = B.Metro.on, onFloor = !!P.onMetroFloor(), y = +P.walk.y.toFixed(1), tr = P.focusTrain();
    B.MetroUI.openBoard(id); await sleep(700); const board = !!B.MetroUI.boardOpen; B.MetroUI.closeAll();
    const f = B.Env.renderer.info.render.frame;
    out.push({ id, plat, ok, on, onFloor, y, board, focus: tr ? tr.line + ' ' + tr.phase : null, fps: +((f - frames0) / ((dwell + 700) / 1000)).toFixed(1) });
    frames0 = f;
    if (!on) break;                                                // (the metro failed: the tour is over; the shell script reports it)
  }
  const bad = out.filter(o => !o.ok || !o.on || !o.onFloor || !o.board);
  return JSON.stringify({ stops: out.length, minutes: +((performance.now() - t0) / 60000).toFixed(1), metroOn: B.Metro.on, bad, out });
});
