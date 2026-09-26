// Joint-station QA map (Millbrae: Caltrain + BART in one building). Run by tools/metro_shots.mjs: { "name",
// "evalFile": this file, "args": { "id": "MLBR", "r": 160, "px": 1100 } }. Draws, over a plan of the area: every
// MetroNet track (BART blue, connector grey), the Caltrain line (red), the Peninsula station's walkable platforms
// (orange, sampled from Stations.platformY), this workstream's platforms (from the built station's walk floors,
// teal) and keep-out zones (outlines), and labels the BART platforms. Returns { png, info }.
async (B, a) => {
  const M = B.MetroStations, st = M.byId[a.id]; if (!st) return { error: 'no station' };
  const R = a.r || 160, PX = a.px || 1100;
  await M.shot(a.id, { u: 0, v: 0, h: 80, pitch: -1.45, settle: 30 });
  for (let i = 0; i < 60; i++) { B.stepFrame(1); await new Promise(r => setTimeout(r, 40)); }
  const pl = st.plan, cx = pl ? pl.cx : st.x, cz = pl ? pl.cz : st.z;
  const cv = document.createElement('canvas'); cv.width = cv.height = PX; const g = cv.getContext('2d');
  const s = PX / (2 * R), X = (x) => (x - cx) * s + PX / 2, Y = (z) => (z - cz) * s + PX / 2;
  g.fillStyle = '#1b1d20'; g.fillRect(0, 0, PX, PX);
  // Peninsula platforms: sample Stations.platformY on a 1 m grid
  const cell = Math.max(1, Math.round(1 / s * 2));
  g.fillStyle = 'rgba(255,150,40,0.55)';
  for (let z = cz - R; z < cz + R; z += 1) for (let x = cx - R; x < cx + R; x += 1) { if (B.Stations.platformY(x, z) !== null) g.fillRect(X(x), Y(z), s + 0.5, s + 0.5); }
  // our walk floors (top view)
  g.fillStyle = 'rgba(40,200,190,0.45)';
  for (const f of (st.walk ? st.walk.floors : [])) { const P = f.poly; g.beginPath(); for (let i = 0; i < P.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(P[i]), Y(P[i + 1])); g.closePath(); g.fill(); }
  // tracks
  const F = {}; const tracks = [];
  const allTracks = B.MetroSim && B.MetroSim.net && B.MetroSim.net.tracks ? B.MetroSim.net.tracks : [];
  for (const t of allTracks) {
    let near = false; for (let i = 0; i < t.n; i += 4) if (Math.abs(t.X[i] - cx) < R && Math.abs(t.Z[i] - cz) < R) { near = true; break; }
    if (!near) continue; tracks.push(t.id);
    g.strokeStyle = t.sys === 'oac' ? '#999' : t.sys === 'ebart' ? '#6c6' : '#4aa3ff'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < t.n; i++) (i ? g.lineTo : g.moveTo).call(g, X(t.X[i]), Y(t.Z[i])); g.stroke();
    const k = Math.floor(t.n / 2); g.fillStyle = '#8cf'; g.font = '11px sans-serif'; g.fillText(t.id, X(t.X[k]) + 4, Y(t.Z[k]));
  }
  // Caltrain line
  g.strokeStyle = '#ff5050'; g.lineWidth = 2; g.beginPath(); let first = true;
  const tn = B.Track.nearest(cx, cz, 2000); if (tn) for (let ds = -R * 1.5; ds <= R * 1.5; ds += 4) { B.Track.frame(tn.s + ds, F); (first ? g.moveTo : g.lineTo).call(g, X(F.x), Y(F.z)); first = false; }
  g.stroke();
  // keep-out zones
  for (const z of M.keepOutZones(cx, cz, R)) { g.strokeStyle = z.kind === 'column' ? '#f44' : 'rgba(255,255,255,0.5)'; g.lineWidth = 1; const P = z.pts; g.beginPath(); for (let i = 0; i < P.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(P[i]), Y(P[i + 1])); g.closePath(); g.stroke(); }
  g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(`${a.id}  ${R * 2} m  orange: Caltrain platforms  teal: BART floors  blue: BART tracks  red: Caltrain line`, 10, 20);
  g.fillRect(10, PX - 20, 50 * s, 3); g.fillText('50 m', 10, PX - 26);
  return { png: cv.toDataURL('image/png'), info: { tracks, plats: st.res && st.res.info && st.res.info.plats, mode: st.res && st.res.info && st.res.info.mode } };
}
