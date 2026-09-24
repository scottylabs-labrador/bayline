// FMissions: flight challenges. Famous approaches (graded landings), flying under the Golden Gate Bridge deck, a gate
// course around San Francisco, an engine failure after takeoff. Gates are drawn as glowing rings with a marker for the
// next one; best scores are kept in the browser.
//   FMissions.list      FMissions.start(id)      FMissions.update(dt)   (per frame while flying)   FMissions.active
const FMissions = (() => {
  const D = Math.PI / 180, KT = 0.514444, FT = 0.3048, NM = 1852;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const LIST = [
    { id: 'sfo-golden', title: 'Butter at SFO', sub: 'A320neo on an 8 nm final to 28R at golden hour. Grade: sink rate, centreline, touchdown zone.', type: 'a320', apt: 'KSFO', rw: '28R', pos: 'final', time: 'golden', goal: 'land' },
    { id: 'gg-under', title: 'Under the Golden Gate', sub: 'Cessna 172 in from the Pacific: fly under the bridge deck (about 65 m of clearance) and live.', type: 'c172', goal: 'gg',
      air: { lat: 37.8095, lon: -122.5650, alt: 160, hdg: 84, kt: 100 } },
    { id: 'bay-gates', title: 'San Francisco gate course', sub: 'Cessna 172: nine gates around the city: Oracle Park, the Bay Bridge, Alcatraz, over the Golden Gate, Ocean Beach, Twin Peaks.', type: 'c172', goal: 'gates',
      air: { lat: 37.705, lon: -122.365, alt: 320, hdg: 350, kt: 105 },
      gates: [[37.7786, -122.3893, 240], [37.7985, -122.3780, 250], [37.8024, -122.4058, 230], [37.8267, -122.4230, 190], [37.8199, -122.4786, 300], [37.7780, -122.5140, 190], [37.7694, -122.4700, 240], [37.7520, -122.4400, 460], [37.7130, -122.3860, 260]] },
    { id: 'lowi', title: 'Into the Alps', sub: 'A320neo down the Inn valley into Innsbruck 26, mountains on both wings.', type: 'a320', apt: 'LOWI', rw: '26', pos: 'final', dist: 9, goal: 'land' },
    { id: 'lxgb', title: 'The Rock', sub: '737-800 into Gibraltar 09: a runway crossed by a road, the Rock alongside.', type: 'b738', apt: 'LXGB', rw: '09', pos: 'final', dist: 6, goal: 'land' },
    { id: 'tncm', title: 'Maho Beach', sub: '747-400 low over the beach onto St Maarten 10: 2,300 m of runway for 330 tonnes.', type: 'b744', apt: 'TNCM', rw: '10', pos: 'final', dist: 6, goal: 'land' },
    { id: 'lpma', title: 'Madeira', sub: 'A320neo into Funchal 05, the runway built out over the sea on columns.', type: 'a320', apt: 'LPMA', rw: '05', pos: 'final', dist: 7, goal: 'land' },
    { id: 'vnlk', title: 'Lukla', sub: 'Cessna 172 onto a 527 m uphill strip at 2,800 m in the Himalaya. Short, steep, unforgiving.', type: 'c172', apt: 'VNLK', rw: '06', pos: 'final', dist: 2.5, goal: 'land' },
    { id: 'eng-out', title: 'Engine failure', sub: '737-800 out of SFO 28R: the right engine quits at 500 ft. Fly the pattern and land back at SFO.', type: 'b738', apt: 'KSFO', rw: '28R', pos: 'runway', goal: 'land', fail: { agl: 150, eng: 1 } },
    { id: 'hnd-auto', title: 'Let it land', sub: 'A320neo on a 12 nm final to Haneda 34L at night: press I to arm the approach and watch the autoland.', type: 'a320', apt: 'RJTT', rw: '34L', pos: 'final', dist: 12, time: 21, goal: 'land' },
    { id: 'lhr-night', title: 'Heavy at night', sub: '787-9 hand-flown onto Heathrow 27L after dark, London lit up below.', type: 'b789', apt: 'EGLL', rw: '27L', pos: 'final', dist: 10, time: 22.5, goal: 'land' },
    { id: 'sf-crown', title: 'Inside the crown', sub: 'H125 over the Embarcadero: set down on the roof of the Salesforce Tower, 300 m up, inside its open crown.', type: 'h125', goal: 'pad',
      air: { lat: 37.7952, lon: -122.3868, alt: 330, hdg: 235, kt: 0 }, pad: { lat: 37.789775, lon: -122.396914, r: 16, minY: 290, y: 306, name: 'the Salesforce Tower roof' } },
    { id: 'gg-tower', title: 'Tower top', sub: 'H125 in the Golden Gate: land on top of the south tower, 227 m above the water. Mind the wind.', type: 'h125', goal: 'pad',
      air: { lat: 37.8175, lon: -122.4700, alt: 250, hdg: 205, kt: 0 }, pad: { lat: 37.8140144, lon: -122.477891, r: 16, minY: 215, y: 227, name: 'the south tower' } },
    { id: 'f16-bay', title: 'Fast and low', sub: 'F-16C over the Bay at 500 kt. Afterburner past 100 % throttle. Try not to break the sound barrier over the city.', type: 'f16', goal: 'free',
      air: { lat: 37.60, lon: -122.25, alt: 600, hdg: 330, kt: 420 } },
  ];
  let cur = null, rings = null, marker = null;
  const best = (() => { try { return JSON.parse(localStorage.getItem('bl-fmissions') || '{}'); } catch (e) { return {}; } })();
  const saveBest = () => { try { localStorage.setItem('bl-fmissions', JSON.stringify(best)); } catch (e) {} };

  async function start(id) {
    const m = LIST.find(x => x.id === id); if (!m) return;
    await Airports.load();
    clear();
    cur = { m, t: 0, gate: 0, passed: 0, missed: 0, done: false, failed: false, lastSide: null, lastPos: null };
    if (m.air) {
      // an air start: the nearest airport anchors the frame, then the aircraft is placed at the given point
      const a = Airports.nearest(m.air.lat, m.air.lon, null, 200000).apt;
      await Flight.start({ type: m.type, apt: a, pos: 'air', time: m.time, assist: Flight.prefs.assist });
      const w = Globe.ll2w(m.air.lat, m.air.lon), ac = Flight.ac, hdg = m.air.hdg * D, gy = Flight.groundFn(w.x, w.z).h;
      const heli = !!Flight.type.fdm.heli;
      ac.place({ x: w.x, y: Math.max(m.air.alt, gy + (heli ? 40 : 120)), z: w.z, hdg, pitch: heli ? 0 : 2 * D, fpa: 0, speed: m.air.kt * KT, gear: heli ? 1 : 0, flaps: 0, thr: m.type === 'f16' ? 0.9 : heli ? 1 : 0.75 });
      Flight.fcs.airStart(0);
      if (heli) Flight.heliAirStart(); else { Flight.fcs.ap.athr = Flight.fcs.assist !== 'direct'; Flight.fcs.ap.spd = m.air.kt; Flight.fcs.ap.thrI = 0.7; }
      Flight.cam.reset();
    } else {
      const a = Airports.byIdent(m.apt); if (!a) { UI.toast('Airport not found: ' + m.apt); return; }
      let time = m.time; if (time === 'golden') time = goldenHour(a);
      await Flight.start({ type: m.type, apt: a, rwIdent: m.rw, pos: m.pos, dist: m.dist, time, assist: Flight.prefs.assist });
    }
    if (m.goal === 'gates') buildRings(m.gates);
    if (m.goal === 'pad') buildPad(m.pad);
    UI.toast(m.title + ': ' + m.sub, 8);
  }
  function goldenHour(a) { const lat = a.lat * D, doy = (Date.now() / 864e5) % 365.25, decl = -23.44 * D * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
    const ha = Math.acos(clamp(-Math.tan(lat) * Math.tan(decl), -1, 1)) / D / 15; return 12 + ha - 0.9 - (a.lon - Math.round(a.lon / 15) * 15) / 15; }
  function clear() {
    clearPad();
    if (rings) { for (const r of rings) { Env.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); } rings = null; }
    cur = null;
  }
  // ---------------------------------------------------------------- gates
  function buildRings(G) {
    rings = G.map((g, i) => {
      const geo = new THREE.TorusGeometry(55, 3.2, 10, 48);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff4fd8, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 8; mesh.layers.enable(1); Env.scene.add(mesh);
      return { lat: g[0], lon: g[1], alt: g[2], mesh, i };
    });
    placeRings();
  }
  function placeRings() {
    if (!rings) return;
    rings.forEach((r, i) => {
      const w = Globe.ll2w(r.lat, r.lon); r.mesh.position.set(w.x, r.alt, w.z);
      const prev = i ? Globe.ll2w(rings[i - 1].lat, rings[i - 1].lon) : Globe.ll2w(cur.m.air.lat, cur.m.air.lon);
      const dx = w.x - prev.x, dz = w.z - prev.z; r.n = new THREE.Vector3(dx, 0, dz).normalize();
      r.mesh.lookAt(w.x + r.n.x, r.alt, w.z + r.n.z);
    });
  }
  // ---------------------------------------------------------------- landing pad target: a flat ring with a beam of light over it
  let pad = null;
  function buildPad(P) {
    const grp = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0x43d9ff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(P.r, 0.5, 8, 48), mat); ring.rotation.x = Math.PI / 2; grp.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 400, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0x43d9ff, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    beam.position.y = 200; grp.add(beam); grp.renderOrder = 8; grp.traverse(o => o.layers && o.layers.enable(1)); Env.scene.add(grp);
    pad = { grp, P, y: null }; placePad();
  }
  function placePad() {
    if (!pad) return; const w = Globe.ll2w(pad.P.lat, pad.P.lon); let y = Flight.roofAt ? Flight.roofAt(w.x, w.z) : null;
    if (y === null) y = Math.max(Flight.groundFn(w.x, w.z).h, pad.P.y || 0); pad.y = y; pad.grp.position.set(w.x, pad.y + 0.6, w.z);   // (exact once the roof is in the collision cache)
  }
  function clearPad() { if (!pad) return; Env.scene.remove(pad.grp); pad.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); pad = null; }
  // ---------------------------------------------------------------- per frame
  const GG = { n: [37.8255026, -122.4792332], s: [37.8140144, -122.477891] };
  function update(dt) {
    if (!cur || !Flight.active) return;
    const m = cur.m, ac = Flight.ac; cur.t += dt;
    if (Flight.crashed && !cur.done) { cur.done = true; cur.failed = true; return; }
    // engine failure
    if (m.fail && !cur.failDone && ac.out.agl > m.fail.agl && !ac.out.onGround) { cur.failDone = true; ac.eng[m.fail.eng].on = false; Flight.warn.flash('ENGINE 2 FAIL'); if (typeof FSound !== 'undefined') FSound.say('engine failure'); UI.toast('Engine failure! Keep the wings level, rudder against the yaw, pitch for speed, and bring it back to SFO.', 7); }
    if (m.goal === 'gates' && rings && !cur.done) {
      const r = rings[cur.gate]; if (r) {
        const rel = ac.pos.clone().sub(r.mesh.position), side = rel.dot(r.n);
        if (cur.lastSide !== null && cur.lastSide < 0 && side >= 0) {
          const inPlane = rel.clone().addScaledVector(r.n, -side).length();
          if (inPlane < 58) { cur.passed++; r.mesh.material.color.set(0x3ef08a); FHud.note(`Gate ${cur.gate + 1} of ${rings.length}`); if (typeof FSound !== 'undefined') FSound.say(String(cur.gate + 1)); }
          else { cur.missed++; r.mesh.material.color.set(0xff5a4a); FHud.note(`Missed gate ${cur.gate + 1}`); }
          r.mesh.material.opacity = 0.35; cur.gate++; cur.lastSide = null;
          if (cur.gate >= rings.length) finishGates();
        } else cur.lastSide = side;
        for (const q of rings) q.mesh.scale.setScalar(q === rings[cur.gate] ? 1 + 0.06 * Math.sin(cur.t * 5) : 1);
      }
    }
    if (m.goal === 'gg' && !cur.done) {
      const n = Globe.ll2w(GG.n[0], GG.n[1]), s = Globe.ll2w(GG.s[0], GG.s[1]);
      const ux = s.x - n.x, uz = s.z - n.z, L = Math.hypot(ux, uz), px = ac.pos.x - n.x, pz = ac.pos.z - n.z;
      const along = (px * ux + pz * uz) / L, side = (px * uz - pz * ux) / L;
      if (cur.lastSide !== null && Math.sign(side) !== Math.sign(cur.lastSide) && along > -350 && along < L + 350) {
        const deck = 70 + 5 * Math.sin(Math.PI * clamp(along / L, 0, 1)), y = ac.pos.y;
        const tower = Math.abs(along) < 9 || Math.abs(along - L) < 9, cable = 77 + 150 * (1 - 4 * (along / L) * (1 - along / L));
        if (tower && y < 228) crashAt('You hit a tower of the Golden Gate Bridge.');
        else if (along > 0 && along < L && y > deck - 9 && y < deck + 2) crashAt('You hit the bridge deck.');
        else if (along > 0 && along < L && y >= deck + 2 && y < cable) crashAt('Tangled in the suspender cables.');
        else if (along > 8 && along < L - 8 && y < deck - 9) { cur.done = true; const score = Math.round(clamp(100 - Math.abs(y - (deck - 9) / 2) * 0.6, 60, 100));
          record('gg-under', score); if (typeof FSound !== 'undefined') FSound.say('under the bridge');
          UI.showResult({ kicker: 'Challenge complete', title: 'Under the Golden Gate', score, grade: score > 90 ? 'Perfectly threaded' : 'Made it', lines: [`Cleared the deck by <b>${Math.round(deck - 9 - y + 9)} m</b>, ${Math.round(y)} m above the water`, `Speed <b>${Math.round(ac.out.cas / KT)} kt</b>`, `Time <b>${Math.round(cur.t)} s</b>`] }); }
        else if (y >= cable) FHud.note('Over the bridge. Try under it!');
      }
      cur.lastSide = side;
    }
    if (m.goal === 'pad' && pad && !cur.done) {
      if ((cur.t % 1) < dt) placePad();                                    // (the roof comes into the collision cache as we get near)
      pad.grp.children[0].scale.setScalar(1 + 0.05 * Math.sin(cur.t * 4));
      const w = pad.grp.position, dist = Math.hypot(ac.pos.x - w.x, ac.pos.z - w.z);
      if (ac.out.onGround && ac.out.gs < 1.5 && cur.t > 3) {
        cur.done = true;
        if (dist < m.pad.r && ac.pos.y > m.pad.minY) {
          const sink = Flight.landed ? Math.abs(Flight.landed.fpm || 0) : 0, score = Math.round(clamp(100 - Math.max(0, sink - 120) * 0.08 - dist * 1.2, 40, 100));
          record(m.id, score); if (typeof FSound !== 'undefined') FSound.say('on the pad');
          setTimeout(() => UI.showResult({ kicker: 'Challenge complete', title: m.title, score, grade: score > 92 ? 'Pinpoint' : score > 75 ? 'On the pad' : 'Down, just', lines: [`Set down <b>${dist.toFixed(1)} m</b> from the centre of ${m.pad.name}`, `<b>${Math.round(ac.pos.y)} m</b> above the sea · ${Math.round(sink)} fpm`, `Time <b>${Math.floor(cur.t / 60)}:${String(Math.round(cur.t % 60)).padStart(2, '0')}</b>`] }), 2600);
        } else UI.toast(`Down ${dist > 999 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m'} from ${m.pad.name}. Lift off (W) and try again`, 6), setTimeout(() => { if (cur && cur.m === m) cur.done = false; }, 4000);
      }
    }
    if (m.goal === 'land' && !cur.done && Flight.landed && Flight.landed.shown) {
      cur.done = true; const sc = Flight.landed.score; record(m.id, sc);
    }
  }
  function crashAt(why) { cur.done = true; cur.failed = true; Flight.crashWith(why); }
  function finishGates() {
    cur.done = true; const t = cur.t, n = rings.length;
    const score = Math.round(clamp(100 * cur.passed / n - Math.max(0, t - 240) * 0.1, 0, 100));
    record('bay-gates', score);
    UI.showResult({ kicker: 'Challenge complete', title: 'San Francisco gate course', score, grade: cur.missed ? `${cur.missed} missed` : 'Clean run', lines: [`Gates <b>${cur.passed} / ${n}</b>`, `Time <b>${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}</b>`, best['bay-gates'] ? `Best <b>${best['bay-gates']}</b>` : ''] });
  }
  function record(id, score) { if (!(best[id] >= score)) { best[id] = score; saveBest(); } }
  // HUD: the next gate as a marker on screen
  function hudMarker(g, W, H, project) {
    if (cur && pad && !cur.done) {
      const p = project(pad.grp.position), d = Flight.ac.pos.distanceTo(pad.grp.position);
      if (p) { g.strokeStyle = '#43d9ff'; g.lineWidth = 2; g.beginPath(); g.arc(p[0], p[1], 14, 0, 7); g.stroke(); g.fillStyle = '#43d9ff'; g.font = '600 12px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText(`PAD · ${d > 999 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} · ${Math.round(pad.y - Flight.ac.pos.y + 2)} m`, p[0], p[1] - 22); }
      return;
    }
    if (!cur || !rings || cur.done) return;
    const r = rings[cur.gate]; if (!r) return;
    const p = project(r.mesh.position); const d = Flight.ac.pos.distanceTo(r.mesh.position);
    if (p) { g.strokeStyle = '#ff4fd8'; g.lineWidth = 2; g.beginPath(); g.arc(p[0], p[1], 14, 0, 7); g.stroke(); g.fillStyle = '#ff4fd8'; g.font = '600 12px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText(`${cur.gate + 1} · ${(d / 1000).toFixed(1)} km`, p[0], p[1] - 22); }
  }
  Globe.onFrame(() => { placeRings(); placePad(); });
  return { list: LIST, start, update, clear, hudMarker, best, get active() { return cur; } };
})();
