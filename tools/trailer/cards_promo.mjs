// Title cards for the promo "A day on the Bay's railways" (node tools/trailer/titles.mjs <outdir> [scale] tools/trailer/cards_promo.mjs):
// big centre titles in the site's condensed caps with one red word, and the end card in layers. Nothing else on
// screen: no lower thirds, no rules, no boxes.
export const css = `
.w { font-size: 132px; letter-spacing: .05em; }
.logo { font-size: 280px; }
.tag { font-size: 46px; margin-top: 70px; letter-spacing: .01em; }
.url { font-size: 32px; margin-top: 54px; letter-spacing: .02em; }
.fine { font-size: 18px; bottom: 44px; }
`;
export const cards = {
  logo: `<div class="c"><div class="logo">Bay<span>line</span></div></div>`,
  railways: `<div class="c"><div class="w">The Bay Area&rsquo;s <em>railways</em></div></div>`,
  live: `<div class="c"><div class="w">Running <em>live</em></div></div>`,
  browser: `<div class="c"><div class="w">In your <em>browser</em></div></div>`,
  endcard: `<div class="c"><div class="scrim"></div><div class="logo">Bay<span>line</span></div><div class="tag">The Bay Area, in motion.</div>
    <div class="url">bayline.tkanz.com</div><div class="play">Free · in your browser</div>
    <div class="fine">Unofficial. Not affiliated with Caltrain, the Peninsula Corridor Joint Powers Board, the San Francisco Bay Area Rapid Transit
    District, or any airline or aircraft manufacturer.<br>Real gameplay, captured in the browser. Music: “Aquarius” by David Celeste · Epidemic Sound.</div></div>`,
};
export const layers = { endcard: { endcard_logo: ['scrim', 'logo'], endcard_tag: ['tag'], endcard_url: ['url', 'play'], endcard_fine: ['fine'] } };
