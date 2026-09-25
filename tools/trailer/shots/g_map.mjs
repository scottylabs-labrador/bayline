// gameplay: the world map. While the scene warms up, the A320 really flies a loop around San Francisco on autopilot at
// 4x sim rate (up the Bay, out the Golden Gate, down the coast, back over the Peninsula), so the map's recorded track
// tells that story. The shot opens on the chase view with the flight HUD, then the pilot opens the map (M): live
// traffic, airports, and the red track of the flight so far (the push-in is done in the edit)
import { cine, flyReady } from './_lib.mjs';
const key = (code, shift = false) => `window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code.slice(3).toLowerCase()}', shiftKey: ${shift}, bubbles: true }))`;
const zoomIn = `(() => { const box = [...document.querySelectorAll('.fov')].find(e => !e.hidden && /World map/i.test(e.textContent)), cv = box && box.querySelector('canvas'); if (!cv) return 0; const r = cv.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  for (let i = 0; i < 3; i++) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  cv.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true })); return 1; })()`;
export default {
  ui: true, css: '#strip, #streambar, #toast, #ftouch, #joy { display: none !important; }',
  hash: '#auto&t=18:02&q=ultraplus!&w=clear&flyat=a320,37.6250,-122.3650,1200,10,250,0,0', warm: 102, frames: 270,
  setup: `async () => { ${cine}; await (${flyReady})(); const B = window.__bayline, F = B.Flight, D = Math.PI / 180;
    B.FHud && B.FHud.setup && B.FHud.setup(false);
    Object.assign(F.fcs.ap, { on: true, alt: 1200, hdg: 10 * D, athr: true, spd: 250 });
    setTimeout(() => { ${key('KeyN')}; ${key('KeyN')}; }, 1500);                                   /* sim rate x4 */
    const turn = (deg) => { F.fcs.ap.on = true; F.fcs.ap.hdg = deg * D; };
    setTimeout(() => turn(285), 28500); setTimeout(() => turn(195), 56500); setTimeout(() => turn(115), 79500);
    return 1; }`,
  prime: `async () => { const B = window.__bayline, F = B.Flight; ${key('KeyN')}; ${key('KeyN')}; ${key('KeyN')};     /* x4 -> x8 -> x16 -> x1 */
    B.Env.time.scale = 1; F.cam.set('chase', true);
    ${key('KeyM')}; ${zoomIn}; await new Promise(r => setTimeout(r, 8000)); ${key('KeyM')};                        /* open the map once so its tiles load */
    await new Promise(r => setTimeout(r, 800)); window.__mapAt = null;
    return { trail: window.__bayline.FMap ? window.__bayline.FMap.trail.length : 'n/a', alt: Math.round(F.ac.pos.y), hdg: Math.round(F.euler.hdg * 180 / Math.PI) }; }`,
  before: `(t) => { if (t >= 1.5 && !window.__mapAt) { window.__mapAt = t; ${key('KeyM')}; ${zoomIn}; } }`,
};
