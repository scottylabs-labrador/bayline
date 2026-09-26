// P19, the system map, full frame (the game's own UI, its schematic view): every line in its colour, every train of the
// evening moving on it, sped up x24 so they visibly flow. The view eases out from the Oakland Wye, where the lines
// meet, to the whole system; the card fills the frame (no side panel). T3 "RUNNING LIVE" sits over it in the edit.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const SCALE = 24;
export default {
  ui: true, hash: '#auto&t=21:05&q=ultra&w=clear', warm: 25, frames: 330,
  css: `#hud, #prompt, #toast, #strip, #cab, #drivebar, #joy, .toast, #mride, #mdmi, #mstrip { display: none !important; } #msys { background: rgba(4,6,9,0.78) !important; } #msys .card { width: 96vw !important; max-width: none !important; height: 94vh !important; max-height: none !important; box-sizing: border-box; } #msys .wrap { grid-template-columns: 1fr !important; } #msys .side { display: none !important; } #msys canvas { height: calc(94vh - 150px) !important; } #msys .close { display: none !important; }`,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 21 * 3600 + 5 * 60);
    const w = __cine.ll(37.795, -122.36, 0); __cine.put({ x: w.x, y: 600, z: w.z }, { x: w.x + 100, y: 400, z: w.z });
    return B.Env.serviceDay().ymd; }`,
  prime: `async () => { const B = window.__bayline, U = B.MetroUI; B.Env.setClock(21 * 3600 + 5 * 60); U.openMap({ view: 'schematic' });
    await new Promise(r => setTimeout(r, 800)); const m = U.mapState; m.sel = null; m.hover = null;
    const c = document.getElementById('msysc'), all = { cx: 15.45, cz: 10.55, scale: Math.min(c.width / 24.2, c.height / 21.6) };
    // the start: the core around the Wye (West Oakland / 12th St / Lake Merritt), 2.3x closer
    window.__MV = { a: { cx: 15.2, cz: 9.1, scale: all.scale * 2.3 }, b: all };
    Object.assign(m.sch, window.__MV.a); B.Env.time.scale = ${SCALE}; await new Promise(r => setTimeout(r, 400));
    B.Env.setClock(21 * 3600 + 5 * 60); return JSON.stringify(window.__MV); }`,
  before: `(t) => { const B = window.__bayline, m = B.MetroUI.mapState, V = window.__MV, k = __cine.ease(Math.max(0, (t - 0.8) / 9.5));
    B.Env.time.scale = ${SCALE}; m.sel = null; m.hover = null;
    const ls = Math.log(V.a.scale) + (Math.log(V.b.scale) - Math.log(V.a.scale)) * k;      // (the zoom eases in log scale: an even pull-out)
    m.sch.scale = Math.exp(ls); m.sch.cx = V.a.cx + (V.b.cx - V.a.cx) * k; m.sch.cz = V.a.cz + (V.b.cz - V.a.cz) * k; }`,
};
