// gameplay: on foot at Palo Alto, the departure board open: the real weekday timetable, trains live
import { cine } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast { display: none !important; }',
  hash: '#auto&t=08:10&q=ultraplus!&w=clear&at=palo_alto', warm: 40, frames: 120,
  setup: `async () => { ${cine}; return 1; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(8 * 3600 + 10 * 60); B.Player.look.yaw = -0.9; B.Player.look.pitch = 0.02;
    B.UI.openBoard(B.Track.byId.palo_alto.idx); return document.getElementById('board').hidden ? 'board hidden' : 'board open'; }`,
};
