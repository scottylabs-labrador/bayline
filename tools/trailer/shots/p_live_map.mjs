// P19, the system map in its geographic view, full frame (the game's own UI): the Bay from above, every line in its
// colour, every train of the evening running on it, sped up (x24) so they visibly flow. The view eases out from the
// Oakland Wye, where the lines meet, to the whole system (T3 "RUNNING LIVE" sits over it in the edit).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const SCALE = 24;
export default {
  ui: true, hash: '#auto&t=21:05&q=ultra&w=clear', warm: 30, frames: 330,
  css: `#hud, #prompt, #toast, #strip, #cab, #drivebar, #joy, .toast, #mride, #mdmi, #mstrip { display: none !important; } #msys { background: rgba(4,6,9,0.72) !important; } #msys .card { width: 96vw !important; max-width: none !important; height: 94vh !important; max-height: none !important; box-sizing: border-box; } #msys .wrap { grid-template-columns: 1fr !important; } #msys .side { display: none !important; } #msys canvas { height: calc(94vh - 150px) !important; } #msys .close { display: none !important; }`,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 21 * 3600 + 5 * 60);
    const w = __cine.ll(37.795, -122.36, 0); __cine.put({ x: w.x, y: 600, z: w.z }, { x: w.x + 100, y: 400, z: w.z });   // (over the Bay: the side panel shows the whole system)
    return B.Env.serviceDay().ymd; }`,
  prime: `async () => { const B = window.__bayline, U = B.MetroUI; B.Env.setClock(21 * 3600 + 5 * 60); U.openMap({ view: 'geo' });
    await new Promise(r => setTimeout(r, 600)); const m = U.mapState; m.sel = null; m.hover = null;
    const c = document.getElementById('msysc'), full = { cx: m.geo.cx, cz: m.geo.cz, scale: m.geo.scale };
    // the whole system: the network's extent; the start: the Wye, 2.4x closer
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const s of B.MetroSim.stations) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
    const fit = Math.min(c.width / ((x1 - x0) * 1.08), c.height / ((z1 - z0) * 1.1)), wye = __cine.ll(37.8015, -122.2800, 0);
    window.__MV = { a: { cx: wye.x, cz: wye.z, scale: fit * 2.4 }, b: { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, scale: fit } };
    // stream the basemap for both ends of the move (the map draws every frame; coarser tiles stand in for missing ones)
    Object.assign(m.geo, window.__MV.b); await new Promise(r => setTimeout(r, 4500)); Object.assign(m.geo, window.__MV.a); await new Promise(r => setTimeout(r, 4500));
    B.Env.setClock(21 * 3600 + 5 * 60); B.Env.time.scale = ${SCALE}; return JSON.stringify(window.__MV); }`,
  before: `(t) => { const B = window.__bayline, m = B.MetroUI.mapState, V = window.__MV, k = __cine.ease(Math.max(0, (t - 0.8) / 9.5));
    B.Env.time.scale = ${SCALE}; m.sel = null; m.hover = null;
    const ls = Math.log(V.a.scale) + (Math.log(V.b.scale) - Math.log(V.a.scale)) * k;      // (the zoom eases in log scale: an even pull-out)
    m.geo.scale = Math.exp(ls); m.geo.cx = V.a.cx + (V.b.cx - V.a.cx) * k; m.geo.cz = V.a.cz + (V.b.cz - V.a.cz) * k; }`,
};
