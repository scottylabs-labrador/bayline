// Title cards for the gameplay video (tools/trailer/edl_gameplay.json): big centre titles, one-line feature
// captions, and the end card (also as layers, revealed in turn).  node tools/trailer/titles.mjs OUT [scale] tools/trailer/cards_gameplay.mjs
export const css = `
.cap { position: absolute; left: 0; right: 0; bottom: 196px; text-align: center; color: #f3efe6; font-family: 'Barlow Condensed'; font-weight: 700;
       font-size: 74px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; text-shadow: 0 0 28px rgba(0,0,0,.7), 0 0 64px rgba(0,0,0,.45), 0 4px 14px rgba(0,0,0,.7); }
.cap em { font-style: normal; color: #e0402f; }
.url { font-size: 40px; margin-top: 52px; letter-spacing: .02em; }
`;
// feature captions: one short line in the big titles' typeface, smaller, centred low in the frame
const cap = (html) => `<div class="cap">${html}</div>`;
export const cards = {
  kicker_open: `<div class="c" style="justify-content:flex-end;padding-bottom:160px"><div class="k">An unofficial rail &amp; flight simulator of the Bay Area</div></div>`,
  t_line: `<div class="c"><div class="w">Drive the <em>line</em></div></div>`,
  t_sky: `<div class="c"><div class="w">Then take to the <em>sky</em></div></div>`,
  logo_drop: `<div class="c"><div class="scrim"></div><div class="logo">Bay<span>line</span></div></div>`,
  t_alive: `<div class="c"><div class="w">The whole Bay. <em>Alive.</em></div></div>`,
  lt_timetable: cap('Every train on the <em>timetable</em>'),
  lt_drive: cap('Signals. Speed limits. <em>PTC.</em>'),
  lt_fly: cap('13 aircraft. Every part <em>animated.</em>'),
  lt_traffic: cap('<em>Live</em> air traffic'),
  lt_map: cap('Every live flight. Including <em>yours.</em>'),
  lt_weather: cap('<em>Live</em> weather'),
  lt_world: cap('1-meter lidar. Millions of real <em>trees.</em>'),
  lt_night: cap('Lit room by <em>room</em>'),
  endcard: `<div class="c"><div class="scrim"></div><div class="logo">Bay<span>line</span></div><div class="tag">Drive the trains. Fly the planes. The whole Bay, live.</div>
    <div class="url">bayline.tkanz.com</div><div class="play">Free · in your browser</div>
    <div class="fine">Unofficial. Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board, or with any airline or aircraft manufacturer.<br>
    Real gameplay, captured in the browser. Music: “Fate of the World” by Christoffer Moe Ditlevsen · Epidemic Sound.</div></div>`,
};
export const layers = { endcard: { endcard_logo: ['scrim', 'logo'], endcard_tag: ['tag'], endcard_url: ['url', 'play'], endcard_fine: ['fine'] } };
