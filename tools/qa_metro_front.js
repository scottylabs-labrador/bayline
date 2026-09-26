// QA (Bayline Metro, M3 gate item 6): the front door, as a player uses it, from the title card (no #auto). Injected with
// tools/shot.mjs --eval by tools/qa_metro_front.sh, which runs it with the metro on and with #metro=0.
// Metro on: the Bayline Metro strip (Ride / Drive / System map), the Bay-wide copy (eyebrow, credits behind "Data &
// credits", the non-affiliation lines visible), the card fits the window, Ride's station search over names, codes and
// aliases, Drive's runs, Back; a station chip starts the game on that platform; the HUD's Metro pill opens the system
// map with its "Unofficial. Not affiliated ..." line; the help keys; no trademark in any visible text (the district's
// legal name appears only inside the non-affiliation lines).
// Metro off (#metro=0): the old card (no strip, the Peninsula copy), no metro help keys, no Metro pill, no metro data loaded.
new Promise(r => { const f = () => window.__bayline && document.querySelector('#title') && !document.querySelector('#title').hidden ? r() : setTimeout(f, 200); f(); }).then(async () => {
  const B = __bayline, sleep = (ms) => new Promise(r => setTimeout(r, ms)), $ = (s) => document.querySelector(s);
  const text = (e) => (e ? e.innerText : '').replace(/\s+/g, ' ').trim();
  const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await sleep(250); } return false; };
  const metro = !!(B.Metro && B.Metro.on), checks = {}, ok = (k, v, info) => { checks[k] = v ? true : (info === undefined ? false : String(info).slice(0, 160)); };
  const NOT_AFFIL = /(Not affiliated with|not affiliated with)[^.]*\./g;              // (the district's name is allowed only in these lines)
  const marks = (s) => { const t = s.replace(NOT_AFFIL, ''); return (t.match(/\bBART\b|Bay Area Rapid Transit/g) || []).length; };
  const card = $('#title .card'), kicker = text($('#title .krow .kicker')), foot = text($('#title .foot > span'));
  const cr = card.getBoundingClientRect();
  if (metro) {
    const mf = $('#title .mfront');
    ok('strip', mf && mf.querySelector('[data-mf="ride"]') && mf.querySelector('[data-mf="drive"]') && mf.querySelector('[data-mf="map"]') && /Bayline Metro/.test(text(mf)), mf ? text(mf) : 'no strip');
    ok('eyebrow', kicker === 'An unofficial Bay Area rail & flight simulator', kicker);
    ok('credits', /not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board, or with the San Francisco Bay Area Rapid Transit District/i.test(foot) && /Data & credits/.test(text($('#title .foot details summary'))), foot);
    ok('fits', cr.top >= 0 && cr.bottom <= innerHeight + 1, `card ${Math.round(cr.top)}..${Math.round(cr.bottom)} in ${innerHeight}`);
    ok('noMarksTitle', marks(text(card)) === 0, text(card));
    // Ride: the station picker, then the search
    mf.querySelector('[data-mf="ride"]').click();
    const pick = mf.querySelector('.pick'), input = mf.querySelector('.pick input');
    ok('ridePicker', await until(() => !pick.hidden && pick.querySelectorAll('[data-mf="st"]').length >= 6, 60000), pick.hidden ? 'hidden' : text(pick));
    const typed = async (q) => { input.value = q; input.dispatchEvent(new Event('input')); await sleep(80); return [...pick.querySelectorAll('[data-mf="st"]')].map(b => b.dataset.id); };
    const want = { 'sfo': 'SFIA', 'San Francisco Airport': 'SFIA', 'oak': 'OAKL', '12th st': '12TH', 'Oakland City Center': '12TH', 'uptown': '19TH', 'Civic Center/UN Plaza': 'CIVC',
      'north san jose': 'BERY', 'Berryessa/North San José': 'BERY', 'temescal': 'MCAR', 'dublin': 'DUBL', 'ferry building': 'EMBR', 'embarcadero': 'EMBR', 'antioch': 'ANTC', 'bay point': 'PITT', 'pittsburg center': 'PCTR', 'coliseum': 'COLS', 'millbrae': 'MLBR' };
    const miss = [];
    for (const [q, id] of Object.entries(want)) { const got = await typed(q); if (got[0] !== id) miss.push(`${q} -> ${got.slice(0, 3).join(',') || 'nothing'} (want ${id})`); }
    ok('search', miss.length === 0, miss.join('; '));
    const none = await typed('zzqx'); ok('searchNone', none.length === 0 && /No station/.test(text(pick)), none.join(','));
    // Drive: the runs; Back
    mf.querySelector('[data-mf="drive"]').click(); await sleep(150);
    const runs = pick.querySelectorAll('[data-mf="mission"]').length; ok('driveRuns', runs >= 1, runs);
    const back = pick.querySelector('[data-mf="back"]'); back.click(); await sleep(100); ok('back', pick.hidden);
    // start on a platform from the search
    mf.querySelector('[data-mf="ride"]').click(); await until(() => pick.querySelectorAll('[data-mf="st"]').length, 20000);
    await typed('Embarcadero'); pick.querySelector('[data-mf="st"]').click();
    const started = await until(() => $('#title').hidden && B.Player.mode === 'walk' && B.Player.onMetroFloor && B.Player.onMetroFloor(), 30000);
    ok('rideStart', started, `title ${$('#title').hidden ? 'hidden' : 'shown'} mode ${B.Player.mode} floor ${!!(B.Player.onMetroFloor && B.Player.onMetroFloor())}`);
    await sleep(1500);
    const where = text($('#hud')); ok('rideHud', /Embarcadero/.test(where), where.slice(0, 160));
    // the HUD pill: the system map and its line
    const pill = $('#hmetro'); ok('hudPill', !!pill && pill.getClientRects().length > 0, pill ? 'hidden' : 'none');
    if (pill) { pill.click(); await sleep(600); }
    ok('map', !!(B.MetroUI && B.MetroUI.mapOpen), 'map not open');
    ok('mapLine', /Unofficial\. Not affiliated with the San Francisco Bay Area Rapid Transit District\./.test(document.body.innerText), 'no line');
    ok('noMarksMap', marks(document.body.innerText) === 0, (document.body.innerText.replace(NOT_AFFIL, '').match(/.{0,40}(\bBART\b|Bay Area Rapid Transit).{0,40}/) || [''])[0]);
    B.UI.closeAll(); if (B.MetroUI.closeAll) B.MetroUI.closeAll(); await sleep(200);
    B.MetroUI.openBoard('EMBR'); await sleep(700);
    ok('noMarksBoard', !!B.MetroUI.boardOpen && marks(document.body.innerText) === 0, B.MetroUI.boardOpen ? 'marks' : 'board not open');
    B.MetroUI.closeAll();
    const keys = text($('#keys')); ok('helpKeys', /Bayline Metro system map/.test(keys) && /Metro driving/.test(keys) && /B at a metro station/.test(keys), keys.slice(0, 120));
    ok('metroOn', B.Metro.on, B.Metro.failed && B.Metro.failed.where);
  } else {
    ok('noStrip', !$('#title .mfront'));
    ok('eyebrow', kicker === 'An unofficial Peninsula rail & flight simulator', kicker);
    ok('credits', /^Unofficial\. Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board\. Timetable/.test(foot) && !$('#title .foot details'), foot.slice(0, 120));
    ok('lede', /124 km commuter line/.test(text($('#title p.lede'))), text($('#title p.lede')).slice(0, 80));
    const keys = text($('#keys')); ok('helpKeys', !/Bayline Metro|Metro driving/.test(keys), 'metro keys shown');
    $('#title [data-go="ride"]').click();
    await until(() => $('#title').hidden, 5000); await sleep(4000);
    ok('noPill', !$('#hmetro'), 'Metro pill shown');
    const N = window.MetroNet; ok('noLoads', !N || (!N.ready && !N.timetableData), 'the metro network or timetable loaded');
    ok('metroOff', !(B.Metro && B.Metro.on));
  }
  const fails = Object.entries(checks).filter(([, v]) => v !== true);
  return JSON.stringify({ metro, fails: fails.length, checks });
});
