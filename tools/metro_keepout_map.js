// Keep-out QA map for one station (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this file,
// "args": { "id": "WOAK", "r": 180, "px": 1100 } }). Flies the camera over the station, lets towns, trees and traffic
// stream, then draws a plan: the station's keep-out zones by kind, roads (grey) and the traffic lanes actually driven
// (blue), OSM buildings (outlined; red = standing in a footprint, would be dropped), trees (green), parked cars
// (orange; red = inside a zone that keeps cars out). Returns { png, counts }.
async (B, a) => {
  const M = B.MetroStations, st = M.byId[a.id]; if (!st) return { error: 'no station ' + a.id };
  const R = a.r || 180, PX = a.px || 1100;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // camera: high over the station (the build, towns, trees and traffic stream around it)
  await M.shot(a.id, { u: 0, v: 0, h: 90, pitch: -1.45, settle: 40 });
  for (let i = 0; i < 160; i++) { B.stepFrame(1); await sleep(40); }
  const pl = st.plan; const cx = pl ? pl.cx : st.x, cz = pl ? pl.cz : st.z;
  const zones = M.keepOutZones(cx, cz, R + 50);
  const roads = B.Towns ? B.Towns.roadsNear(cx, cz, R + 40) : [];
  const blds = B.Towns ? B.Towns.buildingsAt(cx, cz, R + 60) : [];
  const trees = B.Flora && B.Flora.treesNear ? B.Flora.treesNear(cx, cz, R + 20) : [];
  const T = B.World && B.World.traffic;
  // parked and moving cars from the instance buffers (drawn instances; the camera looks straight down, so ~all)
  const cars = [], parked = [];
  if (T) { const gp = T.group.position; const m4 = new THREE.Matrix4();
    for (const k in T.meshes) for (const Mk of [T.meshes[k], T.meshes[k].lo].filter(Boolean)) { const mesh = Mk.mesh;
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m4); const x = m4.elements[12] + gp.x, z = m4.elements[14] + gp.z; const yaw = Math.atan2(-m4.elements[2], m4.elements[0]);
        (i >= (Mk.nMove || 0) ? parked : cars).push({ x, z, yaw }); } } }
  const lanes = T && T.lanes ? T.lanes.map(l => { const gp = T.group.position; const P = []; for (let i = 0; i < l.pts.length; i += 3) P.push(l.pts[i] + gp.x, l.pts[i + 2] + gp.z); return P; }) : [];
  const cv = document.createElement('canvas'); cv.width = cv.height = PX; const g = cv.getContext('2d');
  const s = PX / (2 * R), X = (x) => (x - cx) * s + PX / 2, Y = (z) => (z - cz) * s + PX / 2;
  g.fillStyle = '#1b1d20'; g.fillRect(0, 0, PX, PX);
  const poly = (P, fill, stroke, lw = 1) => { g.beginPath(); for (let i = 0; i < P.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(P[i]), Y(P[i + 1])); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
  // roads
  g.lineCap = 'round';
  for (const rd of roads) { g.strokeStyle = rd.bridge ? '#4a4f58' : '#3a3d42'; g.lineWidth = Math.max(1, (rd.width || 8) * s); g.beginPath(); for (let i = 0; i < rd.pts.length; i += 3) (i ? g.lineTo : g.moveTo).call(g, X(rd.pts[i]), Y(rd.pts[i + 2])); g.stroke(); }
  for (const P of lanes) { g.strokeStyle = 'rgba(90,150,255,0.8)'; g.lineWidth = 1.2; g.beginPath(); for (let i = 0; i < P.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(P[i]), Y(P[i + 1])); g.stroke(); }
  // zones
  const ZC = { deck: 'rgba(160,160,170,0.30)', track: 'rgba(200,120,60,0.35)', lobby: 'rgba(230,60,60,0.45)', plaza: 'rgba(230,140,60,0.35)', column: 'rgba(255,40,40,0.9)', bridge: 'rgba(160,160,200,0.3)', entrance: 'rgba(255,60,200,0.6)' };
  for (const z of zones) poly(z.pts, ZC[z.kind] || 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.25)', 0.5);
  // buildings
  let bDrop = 0;
  for (const b of blds) { const drop = M.dropBuilding({ pts: b.pts }, b.x, b.z); if (drop) bDrop++; poly(b.pts, drop ? 'rgba(255,0,0,0.25)' : null, drop ? '#ff4040' : '#c9c2b0', drop ? 2 : 1); }
  // buildings the footprints dropped (Towns.addDrop): red crosses with their kind and height
  for (const d of M.droppedBuildings || []) { if (Math.abs(d[0] - cx) > R || Math.abs(d[1] - cz) > R) continue; const x = X(d[0]), y = Y(d[1]);
    g.strokeStyle = '#ff3030'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - 8, y - 8); g.lineTo(x + 8, y + 8); g.moveTo(x + 8, y - 8); g.lineTo(x - 8, y + 8); g.stroke();
    g.fillStyle = '#ff8080'; g.font = '12px sans-serif'; g.fillText(`k${d[2]} ${d[3]}m`, x + 10, y - 6); }
  // trees
  let tIn = 0;
  for (const t of trees) { const bad = M.keepOut(t.x, t.z, 'tree'); if (bad) tIn++; g.fillStyle = bad ? '#ff3030' : 'rgba(80,190,90,0.8)'; g.beginPath(); g.arc(X(t.x), Y(t.z), Math.max(1.5, Math.min(6, t.r * s * 0.5)), 0, 6.283); g.fill(); }
  // cars
  let pIn = 0, cIn = 0;
  const car = (c, col) => { g.save(); g.translate(X(c.x), Y(c.z)); g.rotate(-c.yaw); g.fillStyle = col; g.fillRect(-2.3 * s, -0.95 * s, 4.6 * s, 1.9 * s); g.restore(); };
  for (const c of parked) { const bad = M.keepOut(c.x, c.z, 'car'); if (bad) pIn++; car(c, bad ? '#ff2020' : '#f0a030'); }
  for (const c of cars) { const bad = M.keepOut(c.x, c.z, 'road'); if (bad) cIn++; car(c, bad ? '#ff2020' : '#50a0ff'); }
  // scale bar + legend
  g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(`${a.id}  ${R * 2} m  zones ${zones.length}  bldg ${blds.length} (in ${bDrop})  trees ${trees.length} (in ${tIn})  parked ${parked.length} (in ${pIn})  moving ${cars.length} (in ${cIn})`, 10, 20);
  g.fillRect(10, PX - 20, 50 * s, 3); g.fillText('50 m', 10, PX - 26);
  return { png: cv.toDataURL('image/png'), counts: { zones: zones.length, kinds: zones.reduce((o, z) => (o[z.kind] = (o[z.kind] || 0) + 1, o), {}), blds: blds.length, bDrop, trees: trees.length, tIn, parked: parked.length, pIn, cars: cars.length, cIn, lanes: lanes.length } };
}
