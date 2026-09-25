// gameplay: driving. In the cab at Palo Alto, the autopilot's hand on the controller: doors close, power on, away north
import { cine, driveFrom } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast, #joy { display: none !important; }',
  hash: '#auto&t=09:00&q=ultraplus!&w=clear&at=palo_alto', warm: 45, frames: 270,
  setup: `async () => { ${cine}; return 1; }`,
  prime: `() => { window.__d = (${driveFrom})('palo_alto', 0, 9 * 3600, 5); return window.__d; }`,
};
