// Cold approach to a station (lead, M3 hitch budget): run in the page by tools/metro_shots.mjs as the FIRST view of a
// fresh page load: { "name", "evalFile": this file, "args": { "id": "EMBR", "from": 500, "secs": 14, "h0": 120 } }.
// The camera flies in from `from` m out (at h0 m) along the station's axis, descends to the platform and walks along it,
// stepping frames at 30 fps; reports the WebGL program count before / after, the frame-time distribution (the wall time
// of each stepped frame: update + render, so a shader compile or a build step shows), the frames over 16 / 33 ms with
// where they happened, and MetroStations' own slow steps.
async (B, a) => {
  const M = B.MetroStations, st = M.byId[a.id]; if (!st) return { error: 'no station' };
  const R = B.Env.renderer, cam = B.Env.camera, sleep = (ms) => new Promise(r => setTimeout(r, ms));
  if (!st.plan) st.plan = M.makePlan(st.data); const pl = st.plan;
  const yT = pl.plats[0].yRail + (pl.plats[0].ph || M.PLAT_H);
  const from = a.from || 500, secs = a.secs || 14, h0 = a.h0 || 120, N = Math.round(secs * 30);
  const S0 = M.spineAt(pl, -from, {}), S1 = M.spineAt(pl, -40, {});
  const P = (t) => { // t 0..1: along the spine from -from to -40, height h0 -> platform + 1.65 (the last 30 % at platform level)
    const k = Math.min(1, t / 0.7), e = k * k * (3 - 2 * k); const u = -from + (from - 40) * Math.min(1, t / 0.9);
    const S = M.spineAt(pl, u, {}); const y = (1 - e) * (B.Terrain.h(S.x, S.z) + h0) + e * (yT + 1.65);
    return { x: S.x, y, z: S.z, tx: S.tx, tz: S.tz };
  };
  const p0 = R.info.programs ? R.info.programs.length : -1;
  const stats0 = { slow: M.stats.slowSteps.length };
  B.capture.on = true; let tt = 0;
  B.capture.cam = (t, c) => { const p = P(Math.min(1, tt)); c.position.set(p.x, p.y, p.z); c.up.set(0, 1, 0); c.lookAt(p.x + p.tx * 50, p.y - (tt < 0.7 ? 20 * (1 - tt / 0.7) : 0), p.z + p.tz * 50); c.near = 0.05; c.fov = 70; c.updateProjectionMatrix(); };
  const times = [], marks = []; let reveal = null, wasVis = false;
  const progNames = () => (R.info.programs || []).map(p => p.name || '?');
  for (let i = 0; i < N; i++) {
    tt = i / (N - 1);
    const n0 = R.info.programs ? R.info.programs.length : 0, names0 = progNames();
    const t0 = performance.now(); B.stepFrame(1); const dt = performance.now() - t0; times.push(dt);
    const n1 = R.info.programs ? R.info.programs.length : 0, fresh = n1 > n0 ? progNames().slice(n0) : [];
    const vis = !!(st.root && st.root.visible); if (vis && !wasVis && !reveal) reveal = { i, ms: +dt.toFixed(1), newPrograms: n1 - n0, names: fresh };
    wasVis = vis;
    if (dt > 16) marks.push({ i, t: +tt.toFixed(2), ms: +dt.toFixed(1), newPrograms: n1 - n0, names: fresh.slice(0, 6), state: st.state });
    void names0; await sleep(2);
  }
  B.capture.cam = null;
  const sorted = times.slice().sort((x, y) => x - y), q = (f) => +sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))].toFixed(1);
  return { id: a.id, frames: N, programs: { before: p0, after: R.info.programs ? R.info.programs.length : -1 }, ms: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +sorted[sorted.length - 1].toFixed(1) },
    over16: times.filter(x => x > 16).length, over33: times.filter(x => x > 33).length, reveal, marks: marks.slice(0, 60), slowSteps: M.stats.slowSteps.slice(stats0.slow), state: st.state,
    stationPrograms: (R.info.programs || []).filter(p => /stkit|MeshStandard|MeshBasic/.test((p.cacheKey || '') + (p.name || ''))).length };
}
