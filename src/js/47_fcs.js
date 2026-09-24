// FCS: flight control laws and autopilot on top of the FDM (runs every physics substep as env.pre).
//   Assisted handling ("full", the default): a fly-by-wire law by incremental nonlinear dynamic inversion — the stick
//   commands pitch and roll rates; let go and the aircraft holds its flight path and bank (auto-trim), with turn
//   compensation, auto-rudder (turn coordination + yaw damper), load-factor / angle-of-attack / attitude / bank /
//   overspeed protection, and an auto-flare near the runway. "fbw" = the same without the auto-flare. "direct" = the
//   stick moves the surfaces (trim with the trim keys), like a small aircraft with no assists.
//   Autopilot: HDG (bank to a heading), LOC (capture and track a runway centreline), ALT (capture and hold), VS,
//   GS (a 3° glide path to the runway's aiming point), and A/THR (speed hold), with flare and retard at the bottom.
//   const fcs = FCS.create(ac, type)    fcs.pil = { pitch, roll, yaw, thr }  (stick in [-1, 1], pull / right = +)
//   env.pre = fcs.pre                   fcs.assist = 'full' | 'fbw' | 'direct';  fcs.ap = { on, hdg, alt, vs, spd, athr, appr, rwy }
const FCS = (() => {
  const D = Math.PI / 180, G = 9.80665, KT = 0.514444, FTM = 0.3048;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrap = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function create(ac, type) {
    const S = ac.spec, V = type.v, heavy = S.mass > 30000, fighter = S.fbw === 'fighter' || S.fbw === 'aerobatic', ga = !S.retract && S.mass < 8000;
    const K = { phi: 1.4, p: fighter ? 9 : ga ? 5 : 3.2, q: fighter ? 7 : ga ? 4.5 : 2.8, r: fighter ? 5 : ga ? 3 : 2.2, gam: ga ? 0.9 : 0.7 };
    const E = {};
    const f = {
      assist: 'full', pil: { pitch: 0, roll: 0, yaw: 0, thr: 0 },
      gammaHold: 0, phiHold: 0, thetaHold: null, air: 0, flare: false, law: 'ground', hdgHold: null, altHold: null, att: null, hover: false,
      ap: { on: false, hdg: null, alt: null, vs: null, spd: null, athr: false, appr: false, rwy: null, mode: '', thrI: 0.5, gs: false, loc: false, flare: false, retard: false },
      autoSpoilers: true, autoBrake: 0, events: [],
      airStart(gamma) { f.air = 5; f.law = 'flight'; f.gammaHold = gamma; f.phiHold = 0; f.srs = false; f.wasGround = false; f.wasAir = true; },
      pre, info: { phiCmd: 0, gamCmd: 0, qCmd: 0 },
    };
    function flightPath() { const gs = Math.hypot(ac.vel.x, ac.vel.z); return Math.atan2(ac.vel.y, Math.max(gs, 1)); }
    function track() { return (Math.atan2(ac.vel.x, -ac.vel.z) + 2 * Math.PI) % (2 * Math.PI); }

    // ---------------------------------------------------------------- autopilot: targets for the inner loops
    function autopilot(dt, o) {
      const A = f.ap, tas = Math.max(o.tas, 30), alt = ac.pos.y;
      let phiCmd = 0, vsCmd = null;
      // lateral
      if (A.appr && A.rwy) {
        const R = A.rwy; const dx = ac.pos.x - R.x, dz = ac.pos.z - R.z;
        const along = dx * R.ux + dz * R.uz, cross = -dx * R.uz + dz * R.ux;              // cross > 0: right of the centreline
        const course = Math.atan2(R.ux, -R.uz);
        const drift = wrap(track() - E.hdg);
        let hdgCmd;
        // from the wrong side or far off the centreline: first to a fix 14 km out on the extended centreline, then inbound
        const ifx = R.x - R.ux * 14000, ifz = R.z - R.uz * 14000, toIF = Math.hypot(ifx - ac.pos.x, ifz - ac.pos.z);
        if (A.toIF === undefined) A.toIF = !A.loc && (along > -9000 || Math.abs(cross) > 6000 || Math.cos(wrap(E.hdg - course)) < 0.2);
        if (A.toIF && toIF < 3500) A.toIF = false;
        if (A.toIF) hdgCmd = Math.atan2(ifx - ac.pos.x, -(ifz - ac.pos.z)) - drift;
        else { const icpt = clamp(-cross / 28, -30, 30) * D; hdgCmd = course + icpt - drift; }   // intercept angle toward the centreline
        phiCmd = clamp(wrap(hdgCmd - E.hdg) * 2.2, -25 * D, 25 * D);
        if (Math.abs(cross) < 150 && along < 0) A.loc = true;
        // glide path to the aiming point
        const toAim = -(along) + (R.aim || 300);
        const hGp = R.elev + Math.tan(3 * D) * Math.max(toAim, 0) + (ac.spec.cgHeight || 0);   // the glide path meets the runway at the aiming point
        // before the glide path: level at its height over the intercept fix (14 km out), so it is captured from below
        if (!A.gs) { const gsAtIF = R.elev + Math.tan(3 * D) * (14000 + (R.aim || 300)) + (ac.spec.cgHeight || 0) - 40; A.alt = Math.min(A.alt !== null ? A.alt : alt, Math.max(gsAtIF, alt - 2000)); if (A.alt < gsAtIF) A.alt = gsAtIF; }
        if (A.loc && toAim > 0 && (alt < hGp + 60 || toAim < 16000)) A.gs = true;               // from below, or from above when close in
        if (A.gs) {
          const gsV = Math.hypot(ac.vel.x, ac.vel.z);
          vsCmd = -gsV * Math.tan(3 * D) + clamp((hGp - alt) * 0.15, -4.5, 3);                   // (steeper to rejoin from above)
          // flare (sink rate proportional to height) and retard
          const ra = o.agl;
          if (ra < 16 && !o.onGround) A.flare = true;
          if (A.flare) vsCmd = Math.max(vsCmd, -Math.max(0.4, ra / 3.6));
          if (ra < (ac.spec.retardH || 7) && A.athr) A.retard = true;               // (the delta: power on until just above the runway)
        } else if (A.alt !== null) vsCmd = clamp((A.alt - alt) * 0.08, -12, 12);
        if (o.onGround) { A.on = false; A.appr = false; A.athr = false; f.events.push('AUTOLAND COMPLETE'); }
      } else if (A.nav && A.navFn) {
        // direct to: the great-circle track to the destination (wind-corrected), a 3-degree descent in time, then the approach
        const nv = A.navFn(ac.pos);             // { brg (rad), dist (m), elev (m) }
        const drift = wrap(track() - E.hdg), want = nv.brg - drift;
        phiCmd = clamp(wrap(want - E.hdg) * 1.6, -25 * D, 25 * D); A.hdg = ((nv.brg % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const floor = nv.elev + 3000 * FTM, gsm = Math.max(60, Math.hypot(ac.vel.x, ac.vel.z));
        const tod = (ac.pos.y - floor) / Math.tan(3 * D) + 22000;
        if (nv.dist < tod && ac.pos.y > floor + 50) { A.alt = floor; A.vs = -Math.min(gsm * Math.tan(3 * D), 20); A.descending = true; }
        if (nv.dist < 26000 && A.onArrive && !A.arrived) { A.arrived = true; A.onArrive(); }
      } else if (A.hdg !== null) {
        phiCmd = clamp(wrap(A.hdg - E.hdg) * 1.6, -25 * D, 25 * D);
      } else phiCmd = Math.abs(E.roll) < 6 * D ? 0 : E.roll;
      if (!A.gs) {
        if (A.vs !== null && A.alt !== null) {
          const toGo = A.alt - alt, cap = clamp(toGo * 0.1, -Math.abs(A.vs), Math.abs(A.vs));
          vsCmd = Math.abs(toGo) < Math.abs(A.vs) * 12 ? cap : (toGo > 0 ? Math.abs(A.vs) : -Math.abs(A.vs));
        } else if (A.alt !== null) vsCmd = clamp((A.alt - alt) * 0.08, -12, 12);
        else if (A.vs !== null) vsCmd = A.vs;
      }
      if (vsCmd !== null) f.gammaHold = Math.asin(clamp(vsCmd / tas, -0.5, 0.5));
      f.phiHold = phiCmd; f.info.phiCmd = phiCmd;
      // autothrottle
      if (A.athr) athr(dt, o);
    }

    // autothrottle: PI on the speed error with the speed trend as damping (the engines spool slowly)
    function athr(dt, o) {
      const A = f.ap, kt = o.cas / KT;
      A.trend = A.lastKt === undefined ? 0 : A.trend + ((kt - A.lastKt) / dt - A.trend) * Math.min(1, dt * 1.5); A.lastKt = kt;
      if (A.retard) { ac.ctl.thr = Math.max(0, ac.ctl.thr - dt * 0.5); return; }
      if (A.spd === null) return;
      // never below the lowest selectable speed for the flaps in use (1.23 x the 1-g stall speed + 5 kt)
      const vls = typeof AIRCRAFT !== 'undefined' ? AIRCRAFT.vstall(type, ac.mass, Math.floor(ac.flapPos + 0.05)) * (ac.spec.retract ? 1.23 : 1.3) + 5 : 0;
      const err = Math.max(A.spd, vls) - kt, lead = err - A.trend * 4;                // aim at where the speed is heading
      A.thrI = clamp(A.thrI + lead * dt * 0.006, 0.02, A.thrMax || 1);
      ac.ctl.thr = clamp(A.thrI + lead * 0.018, 0, A.thrMax || 1);
    }
    f.athr = athr;

    // ---------------------------------------------------------------- helicopter (assisted): attitude command with auto-level,
    // hover hold (drift nulled), vertical speed command on the collective with altitude hold and gentle arrivals,
    // yaw rate on the pedals with heading hold and turn coordination
    function preHeli(dt) {
      const o = ac.out, c = ac.ctl, P = f.pil; FDM.euler(ac.q, E);
      f.air = !o.onGround ? f.air + dt : 0; f.law = o.onGround ? 'ground' : 'flight';
      if (f.assist === 'direct') { c.coll = clamp(c.thr, 0, 1); c.elev = P.pitch; c.ail = P.roll; c.rud = P.yaw; f.law = 'direct'; return; }
      // collective: climb / descend with W / S, hold the altitude when released
      const pc = P.coll || 0, vsIn = pc > 0.05 ? pc * 5 : pc < -0.05 ? pc * 4 : null;
      if (vsIn !== null) f.altHold = null; else if (f.altHold === null && f.air > 1.5) f.altHold = ac.pos.y;
      let vsCmd = vsIn !== null ? vsIn : f.altHold !== null ? clamp((f.altHold - ac.pos.y) * 0.8, -3, 3) : (o.onGround ? -1 : 0);
      if (vsCmd < 0 && !o.onGround) vsCmd = Math.max(vsCmd, -(0.35 + Math.max(0, o.agl) * 0.22));
      if (f.ap.on && vsIn !== null) f.ap.alt = null;                                  // the pilot's collective takes over the height
      else if (f.ap.on && f.ap.alt !== null) vsCmd = clamp((f.ap.alt - ac.pos.y) * 0.3, -5, 5);
      if (f.ap.on && o.onGround && c.coll < 0.2) f.ap.on = false;
      const az = f.lastVy === undefined ? 0 : (ac.vel.y - f.lastVy) / dt; f.lastVy = ac.vel.y;
      const azCmd = clamp((vsCmd - ac.vel.y) * 1.3, -4, 4);
      if (c.coll === undefined) c.coll = 0.1;
      if (o.onGround && vsCmd <= 0) c.coll = Math.max(0, c.coll - dt * 0.4);
      else c.coll = clamp(c.coll + clamp((azCmd - az) / Math.max(o.Bcoll || 10, 1) * 0.08, -dt * 0.8, dt * 0.8), 0, 1);
      // attitude, each axis on its own: stick = pitch / bank. Released: hold the speed it had (a hover if it was slow
      // or going backwards) through the attitude that gives the wanted acceleration against the fuselage drag, plus a
      // slow integrator. Laterally everything is relative to the trim bank that balances the tail rotor's side force:
      // released, null the drift over the ground in a hover, the sideslip in forward flight
      const gs = Math.hypot(ac.vel.x, ac.vel.z), ch = Math.cos(E.hdg), sh = Math.sin(E.hdg);
      const uh = ac.vel.x * sh - ac.vel.z * ch, vh = ac.vel.x * ch + ac.vel.z * sh;          // forward / right ground speeds
      const pIn = Math.abs(P.pitch) > 0.03, rIn = Math.abs(P.roll) > 0.03, H = S.heli;
      const ttr = H.trMax * ac.surf.rud * (o.rho / 1.225) * ac.rotor.rpm ** 2; f.ttr = (f.ttr || 0) + (ttr - (f.ttr || 0)) * Math.min(1, dt / 0.6);
      const phTrim = o.onGround ? 0 : Math.atan(clamp(f.ttr / (ac.mass * G), -0.15, 0.15));
      // autopilot: heading (or direct to a field: the bearing, then slowing into a hover over it), speed, altitude
      const A = f.ap, apOn = A.on && !o.onGround; let apHdg = null, apU = null, vRef = 0, hold = false;
      if (apOn) {
        const headwind = o.tas - uh;
        if (A.nav && A.navFn) {
          const nv = A.navFn(ac.pos); A.hdg = ((nv.brg % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          if (nv.alt !== undefined) A.alt = nv.alt;                                // (a route point with its own height)
          else { const floor = nv.elev + 500 * FTM; if (A.alt === null || nv.dist < 2500) A.alt = nv.dist < 2500 ? floor : Math.max(A.alt, floor); }
          if (nv.flyby) {                                                           // fly-by: on to the next point once near it, or once it is abeam and we cannot turn onto it
            apU = Math.max(0, (A.spd || 90) * KT - headwind);
            const Rt = gs * gs / (G * Math.tan(28 * D)), trk = Math.atan2(ac.vel.x, -ac.vel.z), behind = Math.cos(wrap(nv.brg - trk)) < 0.2;
            if ((nv.dist < Math.max(220, 0.8 * Rt) || (behind && nv.dist < 2.2 * Rt)) && A.onArrive) A.onArrive();
          }
          else {
            apU = Math.min(Math.max(0, (A.spd || 110) * KT - headwind), Math.sqrt(Math.max(0, nv.dist - 40) * 1.1));
            if (nv.dist < 120 && gs < 4 && !A.arrived) { A.arrived = true; A.nav = null; A.navFn = null; A.spd = 0; apU = 0; if (A.onArrive) A.onArrive(); }
          }
        } else if (A.spd !== null) apU = Math.max(0, A.spd * KT - headwind);
        apHdg = A.hdg;
        // position hold (over a field on arrival, or where the autopilot was engaged in a hover): ground speeds toward the point
        const hp = !A.nav && A.holdFn ? A.holdFn() : null;
        if (hp) { const ex = hp.x - ac.pos.x, ez = hp.z - ac.pos.z, eu = ex * sh - ez * ch, ev = ex * ch + ez * sh, d = Math.hypot(eu, ev) || 1, lim = Math.min(8, 0.8 + d * 0.22);
          apU = eu / d * lim * Math.min(1, d / 3); vRef = ev / d * lim * Math.min(1, d / 3); apHdg = null; hold = true; }
        if (apU !== null && !pIn) { if (!f.att) f.att = { u: apU, i: 0, j: 0 }; f.att.u = hold ? apU : apU < 3 ? 0 : apU; }
      }
      let th, ph;
      if (pIn) { th = P.pitch * 20 * D; f.att = null; }
      else {
        if (!f.att) f.att = { u: uh > 12 ? uh : 0, i: 0, j: 0 };
        const A = f.att, ax = clamp((A.u - uh) * 0.45, -2.5, 2.5), drag = 0.35 * o.rho * H.f * uh * Math.abs(uh) / ac.mass;   // (~70 % of the fuselage drag: the stabiliser and blowback carry the rest)
        A.i = clamp(A.i - (A.u - uh) * dt * 0.004, -0.12, 0.12);
        th = clamp(-Math.atan((ax + drag) / G) + A.i, -18 * D, 16 * D);
      }
      // lateral: in a hover the bank nulls the drift over the ground; in forward flight wings "level" (the trim bank),
      // the pedals keep the sideslip out and a bank turns; blended between 12 and 20 m/s over the ground
      const fw = sstep(12, 20, gs); if (!f.lat) f.lat = { j: 0 };
      if (rIn) { ph = phTrim + P.roll * 35 * D; f.lat.j *= 1 - Math.min(1, dt); }
      else {
        const ve = vh - vRef;                                                     // (the lateral speed wanted: none, or toward a held point)
        f.lat.j = clamp(f.lat.j - ve * dt * 0.01 * (1 - fw), -0.1, 0.1);
        ph = phTrim + (1 - fw) * clamp(Math.atan(clamp(-ve * 0.5, -2, 2) / G) + f.lat.j, -14 * D, 14 * D);
        if (apHdg !== null) { const trk = Math.atan2(ac.vel.x, -ac.vel.z); ph += fw * clamp(wrap(apHdg - (gs > 5 ? trk : E.hdg)) * 1.4, -28 * D, 28 * D); }
      }
      if (o.onGround && c.coll < 0.3) { th = E.pitch; ph = E.roll; }
      const pCmd = clamp(wrap(ph - E.roll) * 3, -S.pMax, S.pMax), qCmd = clamp((th - E.pitch) * 3, -S.qMax, S.qMax);
      c.ail = clamp(ac.surf.ail + (8 * (pCmd - ac.omega.x) - ac.omegaDot.x) / Math.max(o.B.p, 1e-3) * 0.4, -1, 1);
      c.elev = clamp(ac.surf.elev + (6 * (qCmd - ac.omega.y) - ac.omegaDot.y) / Math.max(o.B.q, 1e-3) * 0.4, -1, 1);
      // yaw: pedals = yaw rate; released: hold the heading (hover) or coordinate the turn (forward flight)
      let rCmd;
      if (Math.abs(P.yaw) > 0.03) { rCmd = P.yaw * 0.8; f.hdgHold = null; }
      else {
        if (f.hdgHold === null || fw > 0.5) f.hdgHold = E.hdg;
        if (apHdg !== null && fw < 0.5) f.hdgHold = apHdg;
        const rFwd = (G / Math.max(gs, 1)) * Math.sin(E.roll - phTrim) + 1.5 * (o.beta || 0), rHov = clamp(wrap(f.hdgHold - E.hdg) * 1.5, -0.6, 0.6);
        rCmd = fw * rFwd + (1 - fw) * rHov;
      }
      c.rud = clamp(ac.surf.rud + (4 * (rCmd - ac.omega.z) - ac.omegaDot.z) / Math.max(o.B.r, 1e-3) * 0.4, -1, 1);
      if (o.onGround && c.coll < 0.25) c.rud *= 0.5;
    }

    // ---------------------------------------------------------------- inner loops (every substep)
    function pre(a, dt) {
      if (S.heli) return preHeli(dt);
      const o = ac.out, c = ac.ctl, P = f.pil; FDM.euler(ac.q, E);
      const tas = Math.max(o.tas, 25), cp = Math.cos(E.roll), sp = Math.sin(E.roll);
      const gam = flightPath(); const airborne = !o.onGround;
      const gdot = f.gPrev === undefined ? 0 : (gam - f.gPrev) / dt; f.gPrev = gam; f.gdot = (f.gdot || 0) + (gdot - (f.gdot || 0)) * Math.min(1, dt * 8);   // flight-path rate (flare damping)
      f.air = airborne ? f.air + dt : 0;
      // nose-wheel steering: full at taxi speed, a few degrees at takeoff speed (rudder takes over)
      const gs = o.gs; c.steer = clamp(P.yaw, -1, 1) * (gs < 6 ? 1 : gs > 30 ? 0.08 : 1 - 0.92 * (gs - 6) / 24);
      if (f.assist === 'direct') {
        c.elev = P.pitch; c.ail = P.roll; c.rud = P.yaw; f.law = 'direct';
        return;
      }
      const law = f.air > 0.8 && (o.agl > 1.5 || f.law === 'flight') ? 'flight' : 'ground';     // (flight law until the wheels are down: no switch in the flare)
      if (law === 'flight' && f.law !== 'flight') { f.gammaHold = gam; f.phiHold = 0; f.thetaHold = null; f.srs = f.wasGround && o.gs > 20; }
      if (law === 'ground') f.wasGround = true; else if (f.air > 3) f.wasGround = false;
      f.law = law;
      if (f.ap.on && law === 'flight') autopilot(dt, o);
      else if (f.ap.athr) athr(dt, o);
      // ---------------- roll: rate command, bank hold, bank protection
      let pCmd;
      const phiMax = fighter ? Math.PI : ga ? 60 * D : 67 * D, phiNeutral = fighter || ga ? 1e9 : 33 * D;
      if (law === 'ground') { pCmd = P.roll * S.pMax * 0.3 - E.roll * 2; }
      else if (Math.abs(P.roll) > 0.03 && !f.ap.on) { pCmd = P.roll * S.pMax; f.phiHold = E.roll; }
      else {
        if (!f.ap.on) { if (Math.abs(f.phiHold) < 4 * D) f.phiHold *= 1 - Math.min(1, dt * 0.8); if (Math.abs(f.phiHold) > phiNeutral) f.phiHold = Math.sign(f.phiHold) * phiNeutral; }
        pCmd = clamp(wrap(f.phiHold - E.roll) * K.phi, -S.pMax * (f.ap.on ? 0.25 : 1), S.pMax * (f.ap.on ? 0.25 : 1));
      }
      if (!fighter && law === 'flight') { if (E.roll > phiMax) pCmd = Math.min(pCmd, (phiMax - E.roll) * 2); if (E.roll < -phiMax) pCmd = Math.max(pCmd, (-phiMax - E.roll) * 2); }
      const pdot = K.p * (pCmd - ac.omega.x);
      if (o.B.p > 1e-4) c.ail = clamp(ac.surf.ail + (pdot - ac.omegaDot.x) / o.B.p * 0.5, -1, 1); else c.ail = P.roll;
      // ---------------- pitch: rate command / flight path hold with turn compensation and protections
      const qTurn = law === 'flight' && Math.abs(E.roll) < 80 * D ? (G / tas) * sp * Math.tan(E.roll) * Math.cos(gam) * cp : 0;
      let qCmd;
      const flareZone = law === 'flight' && o.agl < 14 && ac.gearPos > 0.9 && o.vs < 0.5 && !f.ap.on;
      if (law === 'ground') qCmd = P.pitch * Math.min(S.qMax, 10 * D) * 0.75;
      else if (Math.abs(P.pitch) > 0.03 && !(f.ap.on)) { qCmd = qTurn + P.pitch * S.qMax; f.gammaHold = gam; f.flare = false; f.srs = false; }
      else if (f.srs && !f.ap.on && f.assist !== 'direct') {
        // takeoff: hold the initial climb attitude (speed-protected) until 1500 ft or the pilot takes over
        const v2 = (V.v2 || V.r * 1.08 || 60) + 10, kt = o.cas / KT;
        const th = clamp((S.toPitch || (ga ? 8 : fighter ? 14 : 12.5)) * D - Math.max(0, v2 - kt) * 0.5 * D + Math.max(0, kt - v2 - 25) * 0.1 * D, 4 * D, 20 * D);
        qCmd = qTurn + 1.1 * (th - E.pitch); f.gammaHold = gam;
        if (o.agl > 460 || E.pitch > 25 * D) f.srs = false;
      }
      else if (flareZone && f.assist === 'full') {
        // auto-flare: sink rate proportional to height, a gentle arrival
        const vsC = Math.max(o.vs, -Math.max(0.4, o.agl / 3.4)), gC = Math.asin(clamp(vsC / tas, -0.3, 0.3)); f.flare = true;
        qCmd = qTurn + K.gam * (gC - gam) * 2.6 - f.gdot * 1.0; f.gammaHold = gam;
      }
      else qCmd = qTurn + (f.ap.on && f.ap.flare ? K.gam * (f.gammaHold - gam) * 2.6 - f.gdot * 1.0 : K.gam * (f.gammaHold - gam));   // (the flare: damped by the path's rate, no balloon)
      if (law === 'flight') {
        // protections: load factor, angle of attack, pitch attitude, overspeed
        const nMax = S.nMax, nMin = fighter ? -3 : -1;
        const qn = (G / tas) * (nMax - o.nz) * 2 + ac.omega.y; if (qCmd > qn) qCmd = Math.max(qn, qTurn * 0.3);
        const qnm = (G / tas) * (nMin - o.nz) * 2 + ac.omega.y; if (qCmd < qnm) qCmd = qnm;
        const aMax = Math.min(S.alphaMax, o.aS - 1.5 * D), aProt = aMax - 3 * D;     // relative to this flap setting's stall
        if (o.alpha > aProt) qCmd = Math.min(qCmd, (aMax - o.alpha) * 3);
        if (!fighter) { if (E.pitch > 30 * D) qCmd = Math.min(qCmd, (30 * D - E.pitch) * 2); if (E.pitch < -15 * D) qCmd = Math.max(qCmd, (-15 * D - E.pitch) * 2); }
        const vmo = (V.mo || 999) * KT; if (o.cas > vmo + 6 * KT || o.mach > (V.mmo || 9) + 0.01) qCmd = Math.max(qCmd, 1.5 * D);
      }
      if (law === 'flight' && o.agl < 12 && ((f.ap.on && f.ap.flare) || f.flare)) qCmd = Math.max(qCmd, -1.5 * D);   // little nose-down in the flare
      f.info.qCmd = qCmd;
      const qdot = K.q * (qCmd - ac.omega.y);
      if (o.B.q > 1e-4) c.elev = clamp(ac.surf.elev + (qdot - ac.omegaDot.y) / o.B.q * 0.5, -1, 1); else c.elev = P.pitch;
      // ---------------- yaw: turn coordination, sideslip and yaw damping; the pedals add a yaw rate
      if (law === 'ground') {
        c.rud = P.yaw;
        // assisted: hold the runway heading on the takeoff and landing roll while the pedals are free (rudder + steering)
        const roll = f.ap.on && f.ap.appr && f.ap.rwy && f.wasAir;                       // autoland rollout: along the centreline
        if (roll && o.gs < 25 * KT) { f.ap.on = false; f.ap.appr = false; f.ap.athr = false; f.ap.gs = f.ap.loc = f.ap.flare = f.ap.retard = false; f.events.push('AUTOLAND COMPLETE'); }
        if ((f.assist === 'full' || roll) && o.gs > 4 && Math.abs(P.yaw) < 0.05) {
          if (f.hdgHold === null) f.hdgHold = E.hdg;
          if (roll) { const R = f.ap.rwy, cross = -(ac.pos.x - R.x) * R.uz + (ac.pos.z - R.z) * R.ux; f.hdgHold = Math.atan2(R.ux, -R.uz) + clamp(-cross * 0.005, -0.07, 0.07); }
          const e = wrap(f.hdgHold - E.hdg), cmd = clamp(e * 4 - ac.omega.z * 1.6, -1, 1);
          c.rud = cmd; c.steer = cmd * (gs < 6 ? 0.6 : gs > 30 ? 0.08 : 0.6 - 0.52 * (gs - 6) / 24);
        } else f.hdgHold = null;
      }
      else {
        const rCmd = (G / tas) * sp * Math.cos(E.pitch) + o.beta * 1.2 + P.yaw * (fighter ? 0.35 : 0.12);
        const rdot = K.r * (rCmd - ac.omega.z);
        if (o.B.r > 1e-4) c.rud = clamp(ac.surf.rud + (rdot - ac.omegaDot.z) / o.B.r * 0.4, -1, 1); else c.rud = P.yaw;
      }
      // ground spoilers + autobrake on touchdown (armed spoilers deploy when the mains are down with idle thrust)
      if (S.spoilerCL > 0.1 && f.autoSpoilers && o.onGround && o.gs > 20 && c.thr < 0.08 && f.wasAir) { c.spoiler = 1; f.spoilersOut = true; }
      if (f.spoilersOut && (c.thr > 0.3 || o.gs < 8)) { c.spoiler = 0; f.spoilersOut = false; }
      if (f.autoBrake > 0 && o.onGround && f.wasAir && o.gs > 3) c.brake = Math.max(c.brake, f.autoBrake); else if (f.autoBrakeActive && o.gs <= 3) c.brake = 0;
      f.autoBrakeActive = f.autoBrake > 0 && o.onGround && f.wasAir;
      if (airborne && f.air > 2) f.wasAir = true; if (o.onGround && o.gs < 3) f.wasAir = false;
    }
    return f;
  }
  return { create };
})();
