// gameplay: at line speed through Atherton's oaks from the cab, signal clear, PTC active
import { cine, driveMid } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast, #joy { display: none !important; }',
  hash: '#auto&t=10:05&q=ultraplus!&w=clear&at=menlo_park', warm: 45, frames: 180,
  setup: `async () => { ${cine}; return 1; }`,
  prime: `() => { const B = window.__bayline; window.__d = (${driveMid})(B.Track.byId.menlo_park.s - 1900, 1, 10 * 3600 + 5 * 60, 5, 25); return window.__d; }`,
};
