// Draw calls and triangles the whole metro adds to a view (stations, guideway and tunnels, trains): run in the page by
// tools/metro_shots.mjs: { "name", "evalFile": this file, "args": { "views": [{ "id": "EMBR", "opts": {...} }, ...] } }.
// Each view is staged with MetroStations.shot, measured (Post's per-frame counters), then measured again with every
// metro scene group hidden (names matching /metro|under|tube|guide|train/i), and restored. Returns one row per view:
// { id, on: { calls, tris }, off: {...}, dCalls, dTris, groups }.
async (B, a) => {
  const M = B.MetroStations, out = [];
  const meas = () => { for (let i = 0; i < 3; i++) B.stepFrame(1); return { calls: B.Post.stats.calls, tris: B.Post.stats.triangles }; };
  for (const v of a.views) {
    if (v.t) { const [h, m] = v.t.split(':').map(Number); B.Env.setClock(h * 3600 + m * 60); }
    const r = await M.shot(v.id, v.opts || {});
    for (let i = 0; i < 20; i++) { B.stepFrame(1); await new Promise(res => setTimeout(res, 20)); }
    const on = meas();
    const hid = []; for (const c of B.Env.scene.children) if (c.visible && /metro|under|tube|guide|train|consist/i.test(c.name || '')) { c.visible = false; hid.push(c.name); }
    const off = meas(); for (const c of B.Env.scene.children) if (hid.includes(c.name)) c.visible = true;
    out.push({ name: v.name || v.id, state: r.state, on, off, dCalls: on.calls - off.calls, dTris: on.tris - off.tris, groups: hid });
  }
  const names = B.Env.scene.children.map(c => c.name || c.type);
  return { out, scene: names };
}
