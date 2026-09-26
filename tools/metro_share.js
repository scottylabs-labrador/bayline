// The metro's share of a view, part by part (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this
// file, "args": { "views": [{ "name", "id", "opts": {...} } | { "name", "current": true }], "near": "MLBR" } }).
// Each view is staged with MetroStations.shot (or measured at the page's own camera: "current"), then Post's per-frame
// draw calls and triangles are read with everything drawn and again with one part hidden at a time: the stations
// group, the far silhouettes, the guideway and tunnels (metro-infra), the metro's trains, and inside the station
// nearest the camera each zone's structure, its near detail, its signs and boards, the escalator steps and the crowd.
// Returns [{ name, all: { calls, tris }, parts: { part: { calls, tris } (what hiding it saves) } }].
async (B, a) => {
  const M = B.MetroStations, out = [];
  // (time is held still while measuring, and every reading is paired: drawn, hidden, each the least of 4 frames, so
  // streaming and moving trains between readings do not show up as a part's cost)
  const meas = () => { let c = 1e9, t = 1e12; for (let i = 0; i < 4; i++) { B.stepFrame(1); c = Math.min(c, B.Post.stats.calls); t = Math.min(t, B.Post.stats.triangles); } return { calls: c, tris: t }; };
  const save = (all, off) => ({ calls: all.calls - off.calls, tris: all.tris - off.tris });
  const hideMeasure = (objs) => { const on = meas(), was = objs.map(o => o.visible); objs.forEach(o => { o.visible = false; }); const off = meas(); objs.forEach((o, i) => { o.visible = was[i]; }); return save(on, off); };
  const ts = B.Env.time.scale;
  for (const v of a.views) {
    if (!v.current) { if (v.t) { const [h, m] = v.t.split(':').map(Number); B.Env.setClock(h * 3600 + m * 60); } await M.shot(v.id, v.opts || {}); }
    for (let i = 0; i < 40; i++) { B.stepFrame(1); await new Promise(r => setTimeout(r, 25)); }
    B.Env.time.scale = 0; for (let i = 0; i < 6; i++) B.stepFrame(1);
    const all = meas(), parts = {};
    const sc = B.Env.scene.children;
    parts.stations = hideMeasure(sc.filter(c => c.name === 'metrostations'));
    parts.far = hideMeasure(sc.filter(c => c.name === 'metrostations-far'));
    parts.infra = hideMeasure(sc.filter(c => c.name === 'metro-infra'));
    parts.trains = hideMeasure(sc.filter(c => /^metrocar/.test(c.name || '')));
    parts.metroAll = hideMeasure(sc.filter(c => /^metro/.test(c.name || '')));
    // inside the nearest built station: its zones, near groups, signs, boards, steps, people
    const cp = B.Env.camera.position; let st = a.near ? M.byId[a.near] : null;
    if (!st) { let bd = 1e18; for (const s of M.list) if (s.root) { const d = Math.hypot(s.x - cp.x, s.z - cp.z); if (d < bd) { bd = d; st = s; } } }
    if (st && st.root && a.detail !== false) {
      parts.station = { id: st.id, ...hideMeasure([st.root]) };
      for (const g of st.root.children) if (/^zone-/.test(g.name || '')) {
        const near = g.children.filter(c => /-near$/.test(c.name || ''));
        parts[g.name] = hideMeasure([g]);
        if (near.length) parts[g.name + ':near'] = hideMeasure(near);
        const signs = []; for (const n of near) for (const m of n.children) if (m.isMesh && m.material && m.material.map && m.material.emissiveMap) signs.push(m);
        if (signs.length) parts[g.name + ':signs'] = hideMeasure(signs);
        const boards = []; for (const n of near) for (const m of n.children) if (m.isMesh && m.material && m.material.isMeshBasicMaterial && m.material.map) boards.push(m);
        if (boards.length) parts[g.name + ':boards'] = { n: boards.length, ...hideMeasure(boards) };
      }
      const other = st.root.children.filter(c => !/^zone-/.test(c.name || ''));
      if (other.length) parts.stationOther = { names: other.map(c => c.name || c.type).slice(0, 8), ...hideMeasure(other) };
      // (the station crowd is one mesh in the stations group, not under a station root; escalator steps: 'escsteps')
      const grp = sc.find(c => c.name === 'metrostations'), crowd = grp ? grp.children.filter(c => c !== st.root && !/^metro-/.test(c.name || '') && c.isMesh) : [];
      if (crowd.length) parts.crowd = hideMeasure(crowd);
      const steps = []; st.root.traverse(o => { if (o.name === 'escsteps') steps.push(o); }); if (steps.length) parts.escSteps = hideMeasure(steps);
    }
    B.Env.time.scale = ts;
    out.push({ name: v.name || v.id, cam: [cp.x, cp.y, cp.z].map(x => +x.toFixed(1)), all, parts });
  }
  return out;
}
