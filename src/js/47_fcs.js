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

  function create(ac, type) {
    const S = ac.spec, V = type.v, heavy = S.mass > 30000, fighter = S.fbw === 'fighter', ga = !S.retract;
    const K = { phi: 1.4, p: fighter ? 9 : ga ? 5 : 3.2, q: fighter ? 7 : ga ? 4.5 : 2.8, r: fighter ? 5 : ga ? 3 : 2.2, gam: ga ? 0.9 : 0.7 };
    const E = {};
    const f = {
      assist: 'full', pil: { pitch: 0, roll: 0, yaw: 0, thr: 0 },
      gammaHold: 0, phiHold: 0, thetaHold: null, air: 0, flare: false, law: 'ground',
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
        const icpt = clamp(-cross / 28, -30, 30) * D;                                       // intercept angle toward the centreline
        const drift = wrap(track() - E.hdg);
        const hdgCmd = course + icpt - drift;
        phiCmd = clamp(wrap(hdgCmd - E.hdg) * 2.2, -25 * D, 25 * D);
        if (Math.abs(cross) < 150 && along < 0) A.loc = true;
        // glide path to the aiming point
        const toAim = -(along) + (R.aim || 300);
        const hGp = R.elev + Math.tan(3 * D) * Math.max(toAim, 0) + (ac.spec.cgHeight || 0);   // the glide path meets the runway at the aiming point
        if (A.loc && alt < hGp + 60 && toAim > 0) A.gs = true;
        if (A.gs) {
          const gsV = Math.hypot(ac.vel.x, ac.vel.z);
          vsCmd = -gsV * Math.tan(3 * D) + clamp((hGp - alt) * 0.15, -3, 3);
          // flare (sink rate proportional to height) and retard
          const ra = o.agl;
          if (ra < 16 && !o.onGround) A.flare = true;
          if (A.flare) vsCmd = Math.max(vsCmd, -Math.max(0.4, ra / 3.6));
          if (ra < 7 && A.athr) A.retard = true;
        } else if (A.alt !== null) vsCmd = clamp((A.alt - alt) * 0.08, -12, 12);
        if (o.onGround) { A.on = false; A.appr = false; A.athr = false; f.events.push('AUTOLAND COMPLETE'); }
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
      const err = A.spd - kt, lead = err - A.trend * 4;                // aim at where the speed is heading
      A.thrI = clamp(A.thrI + lead * dt * 0.006, 0.02, A.thrMax || 1);
      ac.ctl.thr = clamp(A.thrI + lead * 0.018, 0, A.thrMax || 1);
    }
    f.athr = athr;

    // ---------------------------------------------------------------- inner loops (every substep)
    function pre(a, dt) {
      const o = ac.out, c = ac.ctl, P = f.pil; FDM.euler(ac.q, E);
      const tas = Math.max(o.tas, 25), cp = Math.cos(E.roll), sp = Math.sin(E.roll);
      const gam = flightPath(); const airborne = !o.onGround;
      f.air = airborne ? f.air + dt : 0;
      // nose-wheel steering: full at taxi speed, a few degrees at takeoff speed (rudder takes over)
      const gs = o.gs; c.steer = clamp(P.yaw, -1, 1) * (gs < 6 ? 1 : gs > 30 ? 0.08 : 1 - 0.92 * (gs - 6) / 24);
      if (f.assist === 'direct') {
        c.elev = P.pitch; c.ail = P.roll; c.rud = P.yaw; f.law = 'direct';
        return;
      }
      const law = f.air > 0.8 && o.agl > 1.5 ? 'flight' : 'ground';
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
      if (law === 'ground') qCmd = P.pitch * S.qMax * 0.75;
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
        qCmd = qTurn + K.gam * (gC - gam) * 2.4; f.gammaHold = gam;
      }
      else qCmd = qTurn + K.gam * (f.gammaHold - gam) * (f.ap.on && f.ap.flare ? 2.4 : 1);
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
      f.info.qCmd = qCmd;
      const qdot = K.q * (qCmd - ac.omega.y);
      if (o.B.q > 1e-4) c.elev = clamp(ac.surf.elev + (qdot - ac.omegaDot.y) / o.B.q * 0.5, -1, 1); else c.elev = P.pitch;
      // ---------------- yaw: turn coordination, sideslip and yaw damping; the pedals add a yaw rate
      if (law === 'ground') c.rud = P.yaw;
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
