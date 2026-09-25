// gameplay: braking for Menlo Park, the guide counting down to the stop mark
import { cine, driveMid } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast, #joy { display: none !important; }',
  hash: '#auto&t=10:08&q=ultraplus!&w=clear&at=menlo_park', warm: 45, frames: 180,
  setup: `async () => { ${cine}; return 1; }`,
  prime: `() => { const B = window.__bayline; window.__d = (${driveMid})(B.Sim.stopS(B.Sim.TT.stations.indexOf('menlo_park'), 1), 1, 10 * 3600 + 5 * 60, 16, 0, 'menlo_park'); return window.__d; }`,
};
