// FDM: six-degree-of-freedom flight dynamics for the types in 46_aircraft.js. Pure physics, no rendering.
//   ISA atmosphere; aerodynamic forces and moments from stability and control derivatives with a smooth stall into
//   flat-plate behaviour (pitch break, wing drop), flaps / slats / gear / spoilers, ground effect and compressibility
//   drag rise; piston-propeller, turboprop, turbofan (spool-up, thrust lapse, reverse) and afterburning engines with
//   per-engine thrust moments (engine-out yaw); spring-damper landing gear with rolling / braking / cornering friction
//   and nose-wheel steering; airframe strike points (crash, tail strike); wind; fixed 240 Hz substeps.
// Axes: world = the flat frame (x east, y up, z south). Body = FRD (x forward, y right, z down); q rotates body into
// world. Control inputs are normalised: elev, ail, rud in [-1, 1] (positive = nose up, roll right, nose right),
// thr in [0, 1] (up to 1.1 = afterburner), flaps = notch index, gear 0/1, brake / park / spoiler in [0, 1].
//   const ac = FDM.create(AIRCRAFT.byId.a320.fdm)
//   ac.place({ x, y, z, hdg, pitch, roll, speed, onGround, flaps, gear });  ac.settle(env)
//   ac.step(dt, env)      env = { ground(x, z) -> { h, water, soft }, wind: Vector3, pre(ac, h) }  (pre runs every substep)
//   ac.pos, ac.vel, ac.q, ac.omega (body p, q, r), ac.out (tas, cas, mach, alpha, beta, nz, agl, vs, onGround, touch, crashed, ...)
const FDM = (() => {
  const V3 = THREE.Vector3, G = 9.80665, R_AIR = 287.05, KT = 0.514444;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function atmosphere(h) {
    h = clamp(h, -1000, 32000);
    let T, P;
    if (h < 11000) { T = 288.15 - 0.0065 * h; P = 101325 * Math.pow(T / 288.15, 5.25588); }
    else if (h < 20000) { T = 216.65; P = 22632.06 * Math.exp(-(h - 11000) / 6341.62); }
    else { T = 216.65 + 0.001 * (h - 20000); P = 5474.89 * Math.pow(216.65 / T, 34.1632); }
    const rho = P / (R_AIR * T);
    return { T, P, rho, a: Math.sqrt(1.4 * R_AIR * T), sigma: rho / 1.225 };
  }
  // calibrated airspeed from true airspeed (pitot formula; what the airspeed indicator shows)
  function cas(tas, atm) {
    const M = tas / atm.a; let qc;
    if (M < 1) qc = atm.P * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
    else qc = atm.P * (166.92158 * Math.pow(M, 7) / Math.pow(7 * M * M - 1, 2.5) - 1);    // Rayleigh pitot
    return 340.294 * Math.sqrt(5 * (Math.pow(qc / 101325 + 1, 2 / 7) - 1));
  }

  // attitude quaternion from heading (true, clockwise from north), pitch (up +) and bank (right +), radians
  const _m = new THREE.Matrix4(), f0 = new V3(), r0 = new V3(), d0 = new V3(), fv = new V3(), rv = new V3(), dv = new V3(), UP = new V3(0, 1, 0);
  function attitude(q, hdg, pitch, roll) {
    const ch = Math.cos(hdg), sh = Math.sin(hdg), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    f0.set(sh, 0, -ch); r0.set(ch, 0, sh);
    fv.copy(f0).multiplyScalar(cp).addScaledVector(UP, sp);
    d0.copy(f0).multiplyScalar(sp).addScaledVector(UP, -cp);
    rv.copy(r0).multiplyScalar(cr).addScaledVector(d0, sr);
    dv.copy(d0).multiplyScalar(cr).addScaledVector(r0, -sr);
    _m.makeBasis(fv, rv, dv); return q.setFromRotationMatrix(_m);
  }
  // heading / pitch / bank of an attitude (instruments)
  const ef = new V3(), er = new V3(), eh = new V3(), eu = new V3();
  function euler(q, out = {}) {
    ef.set(1, 0, 0).applyQuaternion(q); er.set(0, 1, 0).applyQuaternion(q);
    out.pitch = Math.asin(clamp(ef.y, -1, 1));
    out.hdg = (Math.atan2(ef.x, -ef.z) + 2 * Math.PI) % (2 * Math.PI);
    eh.set(-ef.z, 0, ef.x); if (eh.lengthSq() < 1e-9) eh.set(1, 0, 0); eh.normalize();   // the level right wing for this heading
    eu.crossVectors(eh, ef).normalize();
    out.roll = Math.atan2(-er.dot(eu), er.dot(eh));
    return out;
  }

  function create(S) {
    const st = {
      spec: S, pos: new V3(), vel: new V3(), q: new THREE.Quaternion(), omega: new V3(), omegaDot: new V3(),
      ctl: { elev: 0, ail: 0, rud: 0, thr: 0, flaps: 0, gear: 1, brake: 0, park: 0, spoiler: 0, trim: 0, rev: 0, steer: 0, brakeL: 0, brakeR: 0 },
      eng: S.engines.map(() => ({ n: 0.2, thrust: 0, on: true })),                                 // n: spool fraction (N1 / rpm)
      flapPos: 0, gearPos: 1, spoilerPos: 0, surf: { elev: 0, ail: 0, rud: 0 },
      out: { tas: 0, cas: 0, gs: 0, alpha: 0, beta: 0, mach: 0, nz: 1, nx: 0, agl: 0, vs: 0, onGround: false, wow: [], stall: 0, crashed: '', touch: null, rho: 1.225, thrust: 0,
        qbar: 0, B: { p: 0, q: 0, r: 0 }, tailStrike: false, gnd: 0, CL: 0 },
      mass: S.mass, t: 0,
    };
    const I = new V3(S.Ixx, S.Iyy, S.Izz);
    const legs = S.gear.map(g => ({ ...g, comp: 0, contact: false, was: false }));
    st.legs = legs;

    function place(o) {
      st.pos.set(o.x, o.y, o.z); attitude(st.q, o.hdg, o.pitch !== undefined ? o.pitch : (o.onGround ? S.restPitch : 0), o.roll || 0);
      if (o.fpa !== undefined) st.vel.set(Math.sin(o.hdg) * Math.cos(o.fpa), Math.sin(o.fpa), -Math.cos(o.hdg) * Math.cos(o.fpa)).multiplyScalar(o.speed || 0);   // along a flight path
      else st.vel.set(1, 0, 0).applyQuaternion(st.q).multiplyScalar(o.speed || 0);
      st.out.agl = o.onGround ? 0 : 999; st.out.onGround = !!o.onGround;
      st.omega.set(0, 0, 0); st.omegaDot.set(0, 0, 0); st.out.crashed = ''; st.out.touch = null; st.out.tailStrike = false;
      st.gearPos = o.onGround || o.gear ? 1 : 0; st.ctl.gear = st.gearPos;
      st.flapPos = o.flaps || 0; st.ctl.flaps = o.flaps || 0; st.spoilerPos = 0; st.ctl.spoiler = 0;
      st.surf.elev = st.surf.ail = st.surf.rud = 0;
      const spool = o.thr !== undefined ? o.thr : 0;
      for (const e of st.eng) { e.n = Math.max(0.2, 0.2 + 0.8 * spool); e.on = true; } st.ctl.thr = spool;
      for (const g of legs) { g.was = !!o.onGround; g.contact = false; }
      if (o.onGround) st.pos.y = o.y + S.cgHeight + 0.02;
    }
    // let the aircraft come to rest on its gear (after place on the ground)
    function settle(env, secs = 3) {
      const park = st.ctl.park; st.ctl.park = 1;
      const pre = env.pre; env.pre = null;
      for (let i = 0; i < secs * 240; i++) { step(1 / 240, env); st.vel.x *= 0.97; st.vel.z *= 0.97; }
      env.pre = pre; st.ctl.park = park; st.out.touch = null; st.out.crashed = '';
    }

    // ---------------------------------------------------------------- one physics step
    const Fw = new V3(), Mb = new V3(), arm = new V3(), cv = new V3(), vb = new V3(), wW = new V3(), fg = new V3(), mW = new V3(), fwd = new V3();
    const qi = new THREE.Quaternion(), dq = new THREE.Quaternion(), wq = new THREE.Quaternion();
    const nF = S.flaps.length - 1, flOut = { dCL: 0, dCLmax: 0, dCD: 0, dCm: 0 };
    function flapAt(p) {                     // flap table interpolated by (continuous) notch position
      if (!nF) return S.flaps[0];
      const i = Math.min(Math.floor(p), nF - 1), t = clamp(p - i, 0, 1), a = S.flaps[i], b = S.flaps[i + 1];
      flOut.dCL = a.dCL + (b.dCL - a.dCL) * t; flOut.dCLmax = a.dCLmax + (b.dCLmax - a.dCLmax) * t; flOut.dCD = a.dCD + (b.dCD - a.dCD) * t; flOut.dCm = a.dCm + (b.dCm - a.dCm) * t;
      return flOut;
    }
    function step(dt, env) {
      const c = st.ctl, out = st.out;
      if (env.pre) env.pre(st, dt);
      st.t += dt;
      // actuators (surfaces move at a finite rate; flaps and gear are slow)
      const rate = dt * 3.5;
      st.surf.elev += clamp(clamp(c.elev, -1, 1) - st.surf.elev, -rate, rate);
      st.surf.ail += clamp(clamp(c.ail, -1, 1) - st.surf.ail, -rate, rate);
      st.surf.rud += clamp(clamp(c.rud, -1, 1) - st.surf.rud, -rate * 0.7, rate * 0.7);
      st.flapPos += clamp(clamp(c.flaps, 0, nF) - st.flapPos, -dt / S.flapTime, dt / S.flapTime);
      if (S.retract) st.gearPos += clamp(c.gear - st.gearPos, -dt / S.gearTime, dt / S.gearTime); else st.gearPos = 1;
      st.spoilerPos += clamp(c.spoiler - st.spoilerPos, -dt * 1.2, dt * 1.2);
      const fl = flapAt(st.flapPos);

      // atmosphere and the air-relative velocity in body axes
      const atm = atmosphere(st.pos.y); out.rho = atm.rho;
      cv.copy(st.vel); if (env.wind) cv.sub(env.wind);
      qi.copy(st.q).invert(); vb.copy(cv).applyQuaternion(qi);
      const V = Math.max(vb.length(), 0.5), u = vb.x, v = vb.y, w = vb.z;
      const alpha = Math.atan2(w, Math.abs(u) < 0.1 ? 0.1 : u), beta = Math.asin(clamp(v / V, -1, 1));
      const qbar = 0.5 * atm.rho * V * V, mach = V / atm.a, qS = qbar * S.S;
      const p = st.omega.x, qq = st.omega.y, r = st.omega.z;
      const ph = p * S.b / (2 * V), qh = qq * S.c / (2 * V), rh = r * S.b / (2 * V);
      // ground under the CG: effect on lift and induced drag (McCormick)
      const gnd = env.ground(st.pos.x, st.pos.z); out.gnd = gnd.h;
      out.agl = st.pos.y - S.cgHeight - gnd.h;
      const hw = Math.max(st.pos.y - gnd.h - (S.wingZ || 0), 0.2) / S.b, ge = (16 * hw) ** 2 / (1 + (16 * hw) ** 2);

      // lift: linear to the stall, then blended into a flat plate; flaps add lift and raise the maximum
      const de = st.surf.elev * S.maxElev + c.trim * S.maxElev * 0.5, da = st.surf.ail * S.maxAil, dr = st.surf.rud * S.maxRud;
      const CL0 = S.CL0 + fl.dCL, CLmax = S.CLmax + fl.dCLmax;
      const aS = (CLmax - CL0) / S.CLa, aN = (-0.75 * S.CLmax - CL0) / S.CLa;
      const sig = 1 / (1 + Math.exp(-(alpha - aS) / 0.028)) + 1 / (1 + Math.exp((alpha - aN) / 0.028));
      const CLlin = CL0 + S.CLa * alpha + S.CLq * qh + S.CLde * de;
      const CLfp = 1.9 * Math.sin(alpha) * Math.cos(alpha);
      let CL = (1 - sig) * CLlin + sig * CLfp;
      CL *= 1 + 0.1 * (1 - ge) * (1 - sig);
      CL -= st.spoilerPos * S.spoilerCL * (1 - sig);
      out.stall = sig; out.CL = CL; out.aS = aS;
      // drag: parasite + induced (less in ground effect) + flaps + gear + spoilers + compressibility
      const k = 1 / (Math.PI * S.e * S.AR);
      let CD = S.CD0 + fl.dCD + st.gearPos * S.gearCD + st.spoilerPos * S.spoilerCD + k * CLlin * CLlin * ge;
      const dM = mach - S.mcrit;
      if (dM > 0) CD += Math.min(20 * dM ** 4, 0.04) * (1 - sstep(1.0, 1.2, mach)) + S.CDwave * sstep(S.mcrit + 0.08, 1.05, mach) / (1 + Math.max(0, mach - 1.3) * (S.waveDecay || 1.2));   // Lock's law through the transonic rise, then wave drag
      CD = (1 - sig) * CD + sig * (1.9 * Math.sin(alpha) ** 2 + S.CD0 + fl.dCD + st.gearPos * S.gearCD);
      const CY = S.CYb * beta + S.CYdr * dr;
      // moments; the stall weakens the controls and brings a pitch break and a wing drop
      const eff = 1 - 0.5 * sig;
      const drop = sig * (0.06 * Math.sin(st.t * 0.9 + 1.3) + 0.04 * Math.sin(st.t * 2.3)) * (1 - 0.6 * Math.min(1, Math.abs(ph) * 20));
      const Cl = S.Clb * beta + S.Clp * ph + S.Clr * rh + (S.Clda * da + S.Cldr * dr) * eff + drop;
      const Cm = S.Cm0 + fl.dCm + S.Cma * alpha + S.Cmq * qh + S.Cmde * de * eff - st.spoilerPos * 0.02 - 0.4 * sig * Math.sin(Math.max(0, alpha - aS * 0.7));
      const Cn = S.Cnb * beta + S.Cnp * ph + S.Cnr * rh + S.Cnda * da + S.Cndr * dr * eff + drop * 0.4;
      // control power (angular acceleration per unit command) for the flight control laws
      out.qbar = qbar; out.B.p = qS * S.b * S.Clda * S.maxAil * eff / I.x; out.B.q = qS * S.c * S.Cmde * S.maxElev * eff / I.y; out.B.r = qS * S.b * S.Cndr * S.maxRud * eff / I.z;
      // forces in body axes (lift and drag act in the stability axes)
      const L = qS * CL, Dg = qS * CD, Y = qS * CY, ca = Math.cos(alpha), sa = Math.sin(alpha);
      const fx = L * sa - Dg * ca, fy = Y, fz = -L * ca - Dg * sa;
      let mx = qS * S.b * Cl, my = qS * S.c * Cm, mz = qS * S.b * Cn;

      // engines (each at its own position: power pitches low-slung engines nose up, one engine out yaws)
      let thrust = 0;
      for (let i = 0; i < st.eng.length; i++) {
        const e = st.eng[i], E = S.engines[i];
        const want = !e.on ? 0 : c.rev && out.onGround ? (E.type === 'prop' ? 0 : 0.78) : clamp(c.thr, 0, 1);
        const target = e.on ? 0.2 + 0.8 * want : 0;
        let tau;
        if (E.type === 'fan') tau = target > e.n ? (E.fast ? 0.9 : 1.8) + (e.n < 0.55 ? (E.fast ? 1.0 : 2.4) : 0) : (E.fast ? 0.8 : 1.5);
        else tau = E.type === 'turboprop' ? 1.2 : 0.3;
        e.n += (target - e.n) * Math.min(1, dt / tau);
        const n = clamp((e.n - 0.2) / 0.8, 0, 1.05);
        let T;
        if (E.type === 'prop') {          // piston: power falls with density; thrust = eta x power / V, capped by the static thrust
          const P = E.power * Math.max(0.04, n) * Math.pow(atm.sigma, 1.1);
          T = Math.min(E.static * Math.max(0.04, n) * Math.pow(atm.sigma, 0.9), E.eta * P / Math.max(V, 1));
          if (n < 0.05) T -= 0.004 * qS;                                        // windmilling prop at idle
        } else if (E.type === 'turboprop') {
          const P = E.power * Math.max(0.05, n) * Math.pow(atm.sigma, 0.7);
          T = Math.min(E.static * Math.max(0.05, n), E.eta * P / Math.max(V, 1));
          if (c.rev && out.onGround) T = -E.static * 0.35 * Math.max(0.1, n);   // beta range: the props bite backwards
        } else {                          // turbofan / turbojet: idle ~5 %, lapse with density and speed (ram helps low-bypass engines)
          const M = Math.min(mach, 2.2), lapse = Math.pow(atm.sigma, 0.8) * Math.min(E.cap || 1.6, 1 - 0.4 * Math.min(M, 1) + (E.ram || 0) * M * M * 0.5);
          T = E.thrust * lapse * (0.05 + 0.95 * Math.pow(Math.min(n, 1), 1.7));
          if (!e.on) T = 0;
          if (E.ab && c.thr > 1.001 && e.on) T += (E.ab - E.thrust) * Math.pow(atm.sigma, 0.8) * Math.min(E.cap || 1.6, 1 - 0.4 * Math.min(M, 1) + (E.abRam || 0) * M * M * 0.5) * clamp((c.thr - 1) * 12, 0, 1) * clamp((n - 0.9) * 10, 0, 1);
          if (c.rev && out.onGround) T = -T * 0.45;
        }
        if (!e.on && E.type !== 'fan') T = Math.min(T, 0);
        e.thrust = T; thrust += T;
        my += E.z * T; mz += -E.y * T;
        if (E.type === 'prop') mz -= T * (S.pfactor || 0);
      }
      out.thrust = thrust;

      // world force: aero + thrust (rotated), gravity
      Fw.set(fx + thrust, fy, fz).applyQuaternion(st.q); Fw.y -= st.mass * G;
      Mb.set(mx, my, mz);

      // ---- landing gear
      let wow = false; wW.copy(st.omega).applyQuaternion(st.q);
      fwd.set(1, 0, 0).applyQuaternion(st.q); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0); fwd.normalize();
      for (let gi = 0; gi < legs.length; gi++) {
        const g = legs[gi]; g.contact = false;
        if (S.retract && !g.fixed && st.gearPos < 0.98) { g.was = false; continue; }
        arm.set(g.x, g.y, g.z).applyQuaternion(st.q);
        const px = st.pos.x + arm.x, py = st.pos.y + arm.y, pz = st.pos.z + arm.z;
        const gh = env.ground(px, pz); const pen = gh.h - py;
        if (pen <= 0) { g.comp = 0; g.was = false; continue; }
        cv.crossVectors(wW, arm).add(st.vel);                                        // contact point velocity
        const vy = cv.y;
        if (!g.was) { g.was = true; if (!out.touch || vy < out.touch.vy) out.touch = { vy, gs: Math.hypot(st.vel.x, st.vel.z), x: px, z: pz, y: gh.h, leg: gi, main: !g.nose }; }
        g.contact = true; g.comp = Math.min(pen, g.maxComp); wow = true;
        if (gh.water && !S.floats) out.crashed = out.crashed || 'water';
        let Fn = Math.max(0, g.k * pen - g.c * vy);
        if (pen > g.maxComp) Fn += g.k * 12 * (pen - g.maxComp);                     // bottomed out: the stops take it
        if (vy < -S.gearVmax && !out.crashed) out.crashed = 'gear';
        // wheel axes on the ground: forward = body forward, turned by the steering (positive = right)
        let ux = fwd.x, uz = fwd.z;
        if (g.steer) { const a = clamp(c.steer, -1, 1) * g.steer, cs = Math.cos(a), sn = Math.sin(a); ux = fwd.x * cs - fwd.z * sn; uz = fwd.x * sn + fwd.z * cs; }
        const lx = -uz, lz = ux;
        const vLong = cv.x * ux + cv.z * uz, vLat = cv.x * lx + cv.z * lz;
        const side = g.y < 0 ? c.brakeL : g.y > 0 ? c.brakeR : 0;
        const brake = g.brake ? Math.max(c.brake, c.park, side) : 0;
        const mu = (gh.soft ? 0.06 : 0.018) + brake * (gh.soft ? 0.32 : gh.wet ? 0.35 : 0.6);
        const fLong = -Math.tanh(vLong / (brake > 0.5 ? 0.06 : 0.3)) * mu * Fn;
        const fLat = -clamp(vLat * g.corner, -0.8, 0.8) * Fn;
        const gx = ux * fLong + lx * fLat, gz = uz * fLong + lz * fLat;
        Fw.x += gx; Fw.y += Fn; Fw.z += gz;
        fg.set(gx, Fn, gz); mW.crossVectors(arm, fg).applyQuaternion(qi); Mb.add(mW);
      }
      out.onGround = wow;
      // ---- airframe strike points: tail strikes scrape, anything else at speed is a crash
      out.tailStrike = false;
      for (const sp of S.strike) {
        if (sp.kind === 'belly' && S.retract && st.gearPos > 0.9) continue;
        arm.set(sp.x, sp.y, sp.z).applyQuaternion(st.q);
        const px = st.pos.x + arm.x, py = st.pos.y + arm.y, pz = st.pos.z + arm.z;
        const gh = env.ground(px, pz); const pen = gh.h - py; if (pen <= 0) continue;
        cv.crossVectors(wW, arm).add(st.vel);
        const sp2 = Math.hypot(cv.x, cv.z);
        if (sp.kind === 'tail') { out.tailStrike = true; if (cv.y < -3.5 && !out.crashed) out.crashed = 'tail'; }
        else if (sp.kind === 'belly') { if (cv.y < -4 && !out.crashed) out.crashed = 'belly'; }
        else if (!out.crashed && (sp2 > 8 || cv.y < -2.5)) out.crashed = gh.water ? 'water' : sp.kind === 'tip' ? 'wingtip' : sp.kind === 'prop' ? 'prop' : sp.kind === 'nacelle' ? 'engine' : 'terrain';
        // contact force + sliding friction (belly landings, scrapes)
        const Fn = Math.max(0, st.mass * G * 3 * pen - st.mass * 1.2 * cv.y);
        const hs = Math.max(sp2, 0.01), fr = 0.45 * Fn;
        fg.set(-cv.x / hs * fr * Math.min(1, hs), Fn, -cv.z / hs * fr * Math.min(1, hs));
        Fw.add(fg); mW.crossVectors(arm, fg).applyQuaternion(qi); Mb.add(mW);
      }

      // ---- integrate (semi-implicit Euler)
      st.vel.addScaledVector(Fw, dt / st.mass);
      const ox = st.omega.x, oy = st.omega.y, oz = st.omega.z;
      const Ix = I.x * ox, Iy = I.y * oy, Iz = I.z * oz;           // gyroscopic: w x (I w)
      const gx2 = oy * Iz - oz * Iy, gy2 = oz * Ix - ox * Iz, gz2 = ox * Iy - oy * Ix;
      st.omega.x += (Mb.x - gx2) / I.x * dt; st.omega.y += (Mb.y - gy2) / I.y * dt; st.omega.z += (Mb.z - gz2) / I.z * dt;
      if (wow) st.omega.multiplyScalar(1 - Math.min(0.5, dt * 1.5));                 // tyre scrub and strut friction
      st.omegaDot.set((st.omega.x - ox) / dt, (st.omega.y - oy) / dt, (st.omega.z - oz) / dt);
      st.pos.addScaledVector(st.vel, dt);
      wq.set(st.omega.x * dt * 0.5, st.omega.y * dt * 0.5, st.omega.z * dt * 0.5, 0);
      dq.multiplyQuaternions(st.q, wq);
      st.q.set(st.q.x + dq.x, st.q.y + dq.y, st.q.z + dq.z, st.q.w + dq.w).normalize();

      // ---- outputs
      out.tas = V; out.cas = cas(V, atm); out.alpha = alpha; out.beta = beta; out.mach = mach;
      out.gs = Math.hypot(st.vel.x, st.vel.z); out.vs = st.vel.y;
      // load factor: specific force along body up (gravity excluded), in g
      Fw.y += st.mass * G; vb.copy(Fw).applyQuaternion(qi); out.nz = -vb.z / (st.mass * G); out.nx = vb.x / (st.mass * G);
    }
    function run(dt, env) {
      if (!(dt > 1e-5)) return;
      const n = Math.max(1, Math.ceil(dt * 240 - 1e-6)), h = dt / n;
      for (let i = 0; i < n; i++) { step(h, env); if (st.out.crashed) break; }
    }
    return Object.assign(st, { place, settle, step: run, flapAt, euler: (o) => euler(st.q, o) });
  }
  return { create, atmosphere, cas, attitude, euler, G, KT };
})();
