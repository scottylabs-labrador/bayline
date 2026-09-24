// San Francisco at golden hour: a slow push from over the Bay toward the skyline and the Salesforce Tower
import { readFileSync } from 'node:fs';
const cine = readFileSync(new URL('../cine.js', import.meta.url), 'utf8');
export default {
  hash: '#auto&t=18:35&q=ultra&w=clear',
  setup: `async () => { ${cine}; const C = window.__cine; C.put(C.ll(37.8005, -122.3745, 330), C.ll(37.7898, -122.3969, 180)); return 1; }`,
  warm: 40, frames: 240,
  before: `(t) => { const C = window.__cine, k = C.ease(t / 8); const p = C.mix(C.ll(37.8005, -122.3745, 330), C.ll(37.7960, -122.3860, 230), k); C.put(p, C.ll(37.7898, -122.3969, 170)); }`,
  cam: `(t, cam) => { const C = window.__cine, k = C.ease(t / 8); const p = C.mix(C.ll(37.8005, -122.3745, 330), C.ll(37.7960, -122.3860, 230), k); C.aim(cam, p, C.ll(37.7898, -122.3969, 170), 42 - 4 * k, 0); }`,
};
