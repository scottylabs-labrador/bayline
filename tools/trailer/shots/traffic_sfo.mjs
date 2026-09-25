// "real traffic": the aircraft actually at SFO right now (live ADS-B), each labelled with its real callsign and type;
// a slow low orbit around the biggest one on the ground (an A380 or 747 when there is one), golden hour
import { cine } from './_lib.mjs';
const C0 = [37.6150, -122.3900];
export default {
  hash: '#auto&t=18:40&q=ultraplus!&w=clear', warm: 60, frames: 240,
  setup: `async () => { ${cine}; const C = __cine, c = C.ll(${C0}, 0); C.put({ x: c.x + 300, y: 120, z: c.z + 300 }, { x: c.x, y: 0, z: c.z }); document.body.classList.remove('photo'); return 1; }`,
  prime: `() => { const B = window.__bayline, T = B.Traffic, C = __cine, c = C.ll(${C0}, 0); B.Env.setClock(18 * 3600 + 40 * 60);
    const rank = { a388: 9, b744: 8, b789: 7, a320: 4, b738: 4 }; let best = null, bs = -1;
    for (const t of T.targets.values()) { const d = Math.hypot(t.pos.x - c.x, t.pos.z - c.z); if (d > 2500 || !t.onGround) continue; const s = (rank[t.cls] || 1) * 10000 - d; if (s > bs) { bs = s; best = t; } }
    if (!best) return 'no aircraft'; window.__tt = best; window.__c0 = { x: best.pos.x, y: best.pos.y, z: best.pos.z }; return best.cs + ' ' + best.type + ' ' + best.cls; }`,
  before: `(t) => { const C = __cine, c = window.__c0; if (!c) return; const a = 0.6 + t * 0.07; C.put({ x: c.x + Math.sin(a) * 120, y: c.y + 38 - t * 1.2, z: c.z + Math.cos(a) * 120 }, c); }`,
  cam: `(t, cam) => { const C = __cine, c = window.__c0; if (!c) return; const a = 0.6 + t * 0.07;
    C.aim(cam, { x: c.x + Math.sin(a) * 120, y: c.y + 38 - t * 1.2, z: c.z + Math.cos(a) * 120 }, { x: c.x, y: c.y + 6, z: c.z }, 44, 0); }`,
};
