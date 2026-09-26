// Station tour (run in the page by tools/metro_shots.mjs --allconsole: { "name", "evalFile": this file, "args":
// { "ids": [...], "look": true } }). Visits each station in turn (camera over it, then on its first platform), waits
// for the build, and reports per station: build state and time, triangles, and MetroStations' hitch counters (the
// longest single build step, steps over 12 ms, our slowest frame); console errors print through metro_shots.
async (B, a) => {
  const M = B.MetroStations, out = [];
  const ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  for (const id of ids) {
    const s0 = M.stats.slowSteps.length, f0 = M.stats.slowFrames.length; M.stats.maxStepMs = 0; M.stats.maxFrameMs = 0;
    const t0 = performance.now();
    const r = await M.shot(id, { u: 0, v: 0, h: 60, pitch: -1.2, settle: 6 });
    if (a.look && r.state === 'built') await M.shot(id, { u: -20, onPlat: 0, h: 1.65, settle: 10 });
    out.push({ id, state: r.state, ms: Math.round(performance.now() - t0), tris: r.tris, maxStep: M.stats.maxStepMs, at: M.stats.maxStepAt, maxFrame: M.stats.maxFrameMs,
      slowSteps: M.stats.slowSteps.slice(s0), slowFrames: M.stats.slowFrames.slice(f0).length, err: r.error || undefined });
  }
  const mem = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) } : null;
  const ri = B.Env.renderer.info; return { out, mem, gl: { geometries: ri.memory.geometries, textures: ri.memory.textures, calls: ri.render.calls }, foot: { stations: M.stats.koStations, ms: Math.round(M.stats.koMs), maxMs: M.stats.maxFootMs } };
}
