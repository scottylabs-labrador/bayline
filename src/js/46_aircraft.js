// Aircraft: the flyable types. Public-spec geometry, masses, engines and speeds; aerodynamic derivatives from the
// open literature (Roskam, Nelson, Heffley & Jewell) or estimated from the geometry, tuned so each type takes
// off, climbs, cruises and lands at its published speeds. Types are named for identification only: every
// aircraft wears the fictional Bayline Air scheme and nothing here is affiliated with a manufacturer or airline.
//   AIRCRAFT.list, AIRCRAFT.byId[id]      { id, name, maker, cat, blurb, fdm (for FDM.create), v (speeds, kt), model (46/48) }
// Axes (fdm and model): body FRD relative to the centre of gravity, metres: x forward, y right, z down.
const AIRCRAFT = (() => {
  const D = Math.PI / 180, G = 9.80665;

  // landing gear legs from a layout: static load shares from the CG position, spring rate for a given static
  // compression, damping for a given ratio of critical
  function gearLegs(mass, o) {
    const W = mass * G, n = o.nose, mains = o.main;
    const xm = mains.reduce((s, m) => s + m.x, 0) / mains.length;
    const Fn = W * (-xm) / (n.x - xm), Fm = (W - Fn) / mains.length;
    const leg = (p, F, extra) => {
      const k = F / o.comp, m = F / G;
      return { x: p.x, y: p.y || 0, z: p.z, k, c: 2 * (o.zeta || 0.75) * Math.sqrt(k * m), maxComp: o.stroke || o.comp * 2.5, corner: 7, ...extra };
    };
    return [leg(n, Fn, { steer: (o.steer || 60) * D, brake: false, nose: true, r: n.r || 0.4, wheels: n.wheels || 1 }),
      ...mains.map(m => leg(m, Fm, { brake: true, r: m.r || 0.5, wheels: m.wheels || 2 }))];
  }
  // flaps / slats table by notch: label, trailing-edge deflection (deg, for the model), slat deflection, and the
  // aerodynamic increments (lift at a given alpha, maximum lift, drag, pitching moment)
  const F = (label, deg, slat, dCL, dCLmax, dCD, dCm = 0) => ({ label, deg, slat, dCL, dCLmax, dCD, dCm });

  const list = [
    // ------------------------------------------------------------------ Cessna 172S Skyhawk
    { id: 'c172', name: 'Cessna 172S Skyhawk', short: 'C172', maker: 'Cessna', cat: 'Light single',
      blurb: 'The most-built aircraft in history: a four-seat high-wing trainer with a 180 hp Lycoming. Forgiving, slow, and a joy over the hills.',
      facts: ['Span 11.0 m', '180 hp piston', 'Cruise 122 kt', 'Stall 48 kt'],
      v: { r: 55, x: 62, y: 74, ref: 65, app: 70, cruise: 115, fe: [110, 85, 85], no: 129, ne: 163, s0: 40, s1: 48, mo: 163, mmo: 0.3, ceil: 14000, cruiseAlt: 6500 },
      fdm: {
        mass: 1040, S: 16.17, b: 11.0, c: 1.49, e: 0.75, CD0: 0.032,
        CL0: 0.31, CLa: 5.0, CLmax: 1.55, CLq: 3.9, CLde: -0.35,
        Cm0: 0.008, Cma: -0.89, Cmq: -12.4, Cmde: 1.28,
        CYb: -0.31, CYdr: -0.187, Clb: -0.089, Clp: -0.47, Clr: 0.096, Clda: 0.13, Cldr: -0.0147,
        Cnb: 0.065, Cnp: -0.03, Cnr: -0.099, Cnda: -0.012, Cndr: 0.0657,
        maxElev: 25 * D, maxAil: 20 * D, maxRud: 17 * D,
        flaps: [F('UP', 0, 0, 0, 0, 0), F('10°', 10, 0, 0.25, 0.2, 0.008), F('20°', 20, 0, 0.45, 0.4, 0.028, -0.01), F('30°', 30, 0, 0.6, 0.55, 0.055, -0.02)],
        flapTime: 3.5, retract: false, gearTime: 1, gearCD: 0, spoilerCL: 0, spoilerCD: 0, mcrit: 0.6, CDwave: 0.05,
        engines: [{ type: 'prop', power: 134000, static: 2400, eta: 0.72, x: 1.7, y: 0, z: -0.15, rpm: [600, 2700], blades: 2, diam: 1.9 }],
        pfactor: 0.03, thrustLine: 0.05, wingZ: -1.0,
        gearLayout: { comp: 0.06, stroke: 0.2, zeta: 0.8, steer: 30,
          nose: { x: 1.35, z: 1.0, r: 0.2, wheels: 1 }, main: [{ x: -0.35, y: -1.25, z: 1.0, r: 0.26, wheels: 1 }, { x: -0.35, y: 1.25, z: 1.0, r: 0.26, wheels: 1 }] },
        strike: [[0.3, -5.5, -0.9, 'tip'], [0.3, 5.5, -0.9, 'tip'], [-5.3, 0, -0.1, 'tail'], [2.15, 0, 0.78, 'prop'], [1.9, 0, 0.55, 'nose'], [0, 0, 0.6, 'belly']],
        Ixx: 1285, Iyy: 1825, Izz: 2667, gearVmax: 3.2, nMax: 3.8, qMax: 18 * D, pMax: 60 * D, alphaMax: 16 * D },
      model: {
        kind: 'ga', L: 8.28, nose: 2.6, fus: { w: 1.12, h: 1.35, zc: 0.05, tailW: 0.16, tailH: 0.32, tailZ: -0.3, noseZ: 0.12 },
        wing: { high: true, x: 0.65, y0: 0.56, span: 5.5, c0: 1.63, c1: 1.13, sweep: 0, dih: 1.7, z: -1.0, t: 0.15, tt: 0.12, twist: -3,
          flap: [0.56, 2.6, 0.3], ail: [2.6, 5.2, 0.28], spoil: null, tip: 'round', strut: true },
        htail: { x: -4.25, span: 1.7, c0: 1.2, c1: 0.85, sweep: 5, dih: 0, z: -0.25, t: 0.1, elev: 0.42 },
        vtail: { x: -3.65, h: 1.55, c0: 1.55, c1: 0.78, sweep: 35, z: -0.4, t: 0.1, rud: 0.4, dorsal: 1.4 },
        engines: [{ type: 'prop', x: 1.95, y: 0, z: -0.15, d: 1.9, blades: 2, spinner: 0.32, cowl: true }],
        gear: { fixed: true, pants: true }, cockpit: { x: 0.35, z: -0.5, y: -0.33, style: 'ga' },
        windows: { style: 'ga' }, livery: { base: '#f5f5f2', stripe: '#b8322a', stripe2: '#1f3a5f', tail: '#f5f5f2', reg: 'N172BL' } },
    },
    // ------------------------------------------------------------------ Airbus A320neo
    { id: 'a320', name: 'Airbus A320neo', short: 'A320', maker: 'Airbus', cat: 'Narrow-body jet',
      blurb: 'The best-selling airliner family: fly-by-wire, sidestick, sharklets and geared-fan engines. 180 seats, 3,400 nm.',
      facts: ['Span 35.8 m', '2 × 121 kN', 'Cruise M 0.78', 'MTOW 79 t'],
      v: { r: 143, v2: 148, ref: 132, app: 137, cruise: 450, fe: [230, 215, 200, 185, 177], le: 280, mo: 350, mmo: 0.82, ceil: 39800, cruiseAlt: 35000, s1: 145, gd: 205 },
      fdm: {
        mass: 64000, S: 122.6, b: 35.8, c: 4.29, e: 0.84, CD0: 0.0205,
        CL0: 0.23, CLa: 5.6, CLmax: 1.45, CLq: 5.4, CLde: -0.3,
        Cm0: 0.03, Cma: -1.2, Cmq: -18, Cmde: 1.4,
        CYb: -0.8, CYdr: -0.18, Clb: -0.15, Clp: -0.45, Clr: 0.12, Clda: 0.1, Cldr: -0.008,
        Cnb: 0.14, Cnp: -0.08, Cnr: -0.28, Cnda: -0.004, Cndr: 0.1,
        maxElev: 25 * D, maxAil: 25 * D, maxRud: 25 * D,
        flaps: [F('0', 0, 0, 0, 0, 0), F('1', 0, 18, 0.05, 0.35, 0.005), F('1+F', 10, 18, 0.3, 0.55, 0.012), F('2', 15, 22, 0.45, 0.75, 0.02, -0.02), F('3', 20, 22, 0.55, 0.85, 0.03, -0.04), F('FULL', 35, 27, 0.8, 1.1, 0.055, -0.08)],
        flapTime: 7, retract: true, gearTime: 10, gearCD: 0.018, spoilerCL: 0.35, spoilerCD: 0.06, mcrit: 0.74, CDwave: 0.08,
        engines: [{ type: 'fan', thrust: 120600, x: 3.2, y: -5.75, z: 1.9 }, { type: 'fan', thrust: 120600, x: 3.2, y: 5.75, z: 1.9 }],
        thrustLine: 0, wingZ: 1.3,
        gearLayout: { comp: 0.2, stroke: 0.45, zeta: 0.75, steer: 70,
          nose: { x: 11.34, z: 3.4, r: 0.38, wheels: 2 }, main: [{ x: -1.3, y: -3.8, z: 3.4, r: 0.58, wheels: 2 }, { x: -1.3, y: 3.8, z: 3.4, r: 0.58, wheels: 2 }] },
        strike: [[-14, 0, 0.55, 'tail'], [-4.4, -17.9, 0, 'tip'], [-4.4, 17.9, 0, 'tip'], [2.0, -5.75, 2.65, 'nacelle'], [2.0, 5.75, 2.65, 'nacelle'], [17.5, 0, 0.8, 'nose'], [0, 0, 2.0, 'belly'], [-8, 0, 1.8, 'belly']],
        Ixx: 1.3e6, Iyy: 3.2e6, Izz: 4.4e6, gearVmax: 4.6, nMax: 2.5, qMax: 5 * D, pMax: 15 * D, alphaMax: 13 * D, fbw: 'airbus' },
      model: {
        kind: 'jet', L: 37.57, nose: 17.3, fus: { d: 3.95, h: 4.14, zc: 0.2, noseLen: 5.6, tailLen: 11.5, tailUp: 1.25 },
        wing: { x: 3.9, y0: 1.9, span: 17.9, c0: 7.0, cK: 3.9, yK: 6.2, c1: 1.5, sweep: 27, dih: 5.1, z: 1.3, t: 0.15, tt: 0.11, twist: -4,
          flap: [2.1, 10.5, 0.3], ail: [11, 15.4, 0.25], spoil: [[3.2, 10.3]], tip: 'sharklet', slats: true, fairings: 3 },
        htail: { x: -13.8, span: 6.25, c0: 3.7, c1: 1.3, sweep: 32, dih: 6, z: -0.5, t: 0.1, elev: 0.3 },
        vtail: { x: -11.8, h: 5.9, c0: 5.9, c1: 2.2, sweep: 36, z: -1.6, t: 0.1, rud: 0.32 },
        engines: [{ type: 'fan', x: 3.2, y: -5.75, z: 1.9, d: 2.37, len: 4.3, pylon: 1.0, fanD: 2.06, style: 'leap' }, { type: 'fan', x: 3.2, y: 5.75, z: 1.9, d: 2.37, len: 4.3, pylon: 1.0, fanD: 2.06, style: 'leap' }],
        gear: { noseX: 11.34, mainX: -1.3, track: 3.8 }, cockpit: { x: 14.4, z: -0.9, y: -0.55, style: 'airbus' },
        windows: { x0: 11.2, x1: -12.0, pitch: 0.533, z: -0.45, doors: [12.3, 7.4, -10.6] }, livery: { base: '#f7f7f5', tail: '#b3261e', stripe: '#1d3557', belly: '#dfe2e6', reg: 'N320BL' } },
    },
    // ------------------------------------------------------------------ Boeing 737-800
    { id: 'b738', name: 'Boeing 737-800', short: '737-800', maker: 'Boeing', cat: 'Narrow-body jet',
      blurb: 'The workhorse of the short haul: 189 seats, split-flap trailing edges, CFM56 engines hung low under a 35.8 m wing with blended winglets.',
      facts: ['Span 35.8 m', '2 × 121 kN', 'Cruise M 0.785', 'MTOW 79 t'],
      v: { r: 147, v2: 153, ref: 140, app: 145, cruise: 455, fe: [250, 250, 250, 210, 200, 190, 175, 162], le: 270, mo: 340, mmo: 0.82, ceil: 41000, cruiseAlt: 37000, s1: 150 },
      fdm: {
        mass: 65000, S: 124.6, b: 35.8, c: 3.96, e: 0.82, CD0: 0.021,
        CL0: 0.22, CLa: 5.5, CLmax: 1.4, CLq: 5.4, CLde: -0.3,
        Cm0: 0.03, Cma: -1.25, Cmq: -18, Cmde: 1.4,
        CYb: -0.8, CYdr: -0.18, Clb: -0.16, Clp: -0.45, Clr: 0.12, Clda: 0.1, Cldr: -0.008,
        Cnb: 0.14, Cnp: -0.08, Cnr: -0.28, Cnda: -0.004, Cndr: 0.1,
        maxElev: 25 * D, maxAil: 25 * D, maxRud: 25 * D,
        flaps: [F('UP', 0, 0, 0, 0, 0), F('1', 1, 15, 0.1, 0.35, 0.004), F('2', 2, 15, 0.16, 0.45, 0.006), F('5', 5, 15, 0.25, 0.6, 0.011), F('10', 10, 25, 0.35, 0.7, 0.016),
          F('15', 15, 25, 0.45, 0.8, 0.022, -0.01), F('25', 25, 25, 0.6, 0.9, 0.035, -0.03), F('30', 30, 25, 0.72, 0.95, 0.05, -0.05), F('40', 40, 25, 0.85, 1.05, 0.07, -0.07)],
        flapTime: 5, retract: true, gearTime: 9, gearCD: 0.018, spoilerCL: 0.35, spoilerCD: 0.06, mcrit: 0.745, CDwave: 0.08,
        engines: [{ type: 'fan', thrust: 121400, x: 4.4, y: -4.9, z: 1.75 }, { type: 'fan', thrust: 121400, x: 4.4, y: 4.9, z: 1.75 }],
        thrustLine: 0, wingZ: 1.2,
        gearLayout: { comp: 0.2, stroke: 0.45, zeta: 0.75, steer: 78,
          nose: { x: 14.0, z: 2.9, r: 0.35, wheels: 2 }, main: [{ x: -1.6, y: -2.86, z: 2.9, r: 0.56, wheels: 2 }, { x: -1.6, y: 2.86, z: 2.9, r: 0.56, wheels: 2 }] },
        strike: [[-15.6, 0, 0.0, 'tail'], [-5.6, -17.0, 0.2, 'tip'], [-5.6, 17.0, 0.2, 'tip'], [3.0, -4.9, 2.25, 'nacelle'], [3.0, 4.9, 2.25, 'nacelle'], [19.2, 0, 0.8, 'nose'], [0, 0, 1.9, 'belly'], [-8, 0, 1.7, 'belly']],
        Ixx: 1.35e6, Iyy: 3.4e6, Izz: 4.5e6, gearVmax: 4.6, nMax: 2.5, qMax: 5 * D, pMax: 15 * D, alphaMax: 14 * D },
      model: {
        kind: 'jet', L: 39.5, nose: 19.4, fus: { d: 3.76, h: 4.01, zc: 0.25, noseLen: 5.2, tailLen: 11.0, tailUp: 1.3 },
        wing: { x: 4.3, y0: 1.85, span: 17.1, c0: 7.3, cK: 4.0, yK: 5.6, c1: 1.25, sweep: 27, dih: 6, z: 1.2, t: 0.155, tt: 0.11, twist: -3,
          flap: [2.0, 10.3, 0.3], ail: [10.8, 15.0, 0.24], spoil: [[3.0, 10.1]], tip: 'winglet', slats: true, fairings: 3 },
        htail: { x: -14.8, span: 7.2, c0: 3.8, c1: 1.25, sweep: 32, dih: 7, z: -0.55, t: 0.1, elev: 0.3 },
        vtail: { x: -12.9, h: 6.0, c0: 6.1, c1: 1.9, sweep: 36, z: -1.5, t: 0.1, rud: 0.3, dorsal: 3.2 },
        engines: [{ type: 'fan', x: 4.4, y: -4.9, z: 1.75, d: 2.1, len: 4.2, pylon: 0.5, fanD: 1.55, style: 'cfm' }, { type: 'fan', x: 4.4, y: 4.9, z: 1.75, d: 2.1, len: 4.2, pylon: 0.5, fanD: 1.55, style: 'cfm' }],
        gear: { noseX: 14.0, mainX: -1.6, track: 2.86 }, cockpit: { x: 15.9, z: -0.85, y: -0.53, style: 'boeing' },
        windows: { x0: 12.8, x1: -12.8, pitch: 0.508, z: -0.45, doors: [14.4, 9.0, -12.0] }, livery: { base: '#f7f7f5', tail: '#1d3557', stripe: '#b3261e', belly: '#dfe2e6', reg: 'N738BL' } },
    },
    // ------------------------------------------------------------------ Boeing 787-9
    { id: 'b789', name: 'Boeing 787-9 Dreamliner', short: '787-9', maker: 'Boeing', cat: 'Wide-body jet',
      blurb: 'Composite wide-body with raked wingtips that flex 3 m in flight, chevron nacelles and 7,500 nm of range.',
      facts: ['Span 60.1 m', '2 × 320 kN', 'Cruise M 0.85', 'MTOW 254 t'],
      v: { r: 160, v2: 168, ref: 145, app: 150, cruise: 488, fe: [255, 235, 215, 215, 210, 205, 180, 175], le: 270, mo: 350, mmo: 0.9, ceil: 43000, cruiseAlt: 39000, s1: 155 },
      fdm: {
        mass: 200000, S: 377, b: 60.12, c: 7.6, e: 0.9, CD0: 0.018,
        CL0: 0.25, CLa: 5.6, CLmax: 1.45, CLq: 5.4, CLde: -0.3,
        Cm0: 0.03, Cma: -1.3, Cmq: -20, Cmde: 1.35,
        CYb: -0.85, CYdr: -0.17, Clb: -0.18, Clp: -0.45, Clr: 0.11, Clda: 0.11, Cldr: -0.007,
        Cnb: 0.15, Cnp: -0.1, Cnr: -0.3, Cnda: 0, Cndr: 0.1,
        maxElev: 25 * D, maxAil: 25 * D, maxRud: 25 * D,
        flaps: [F('UP', 0, 0, 0, 0, 0), F('1', 0, 20, 0.08, 0.35, 0.004), F('5', 5, 20, 0.25, 0.6, 0.01), F('15', 15, 20, 0.42, 0.78, 0.02), F('17', 17, 20, 0.45, 0.8, 0.022),
          F('18', 18, 20, 0.46, 0.81, 0.023), F('20', 20, 20, 0.5, 0.83, 0.026, -0.02), F('25', 25, 25, 0.62, 0.87, 0.036, -0.04), F('30', 30, 25, 0.75, 0.9, 0.05, -0.06)],
        flapTime: 6, retract: true, gearTime: 11, gearCD: 0.016, spoilerCL: 0.35, spoilerCD: 0.06, mcrit: 0.79, CDwave: 0.08,
        engines: [{ type: 'fan', thrust: 320000, x: 6.0, y: -9.9, z: 2.3 }, { type: 'fan', thrust: 320000, x: 6.0, y: 9.9, z: 2.3 }],
        thrustLine: 0, wingZ: 1.7,
        gearLayout: { comp: 0.25, stroke: 0.55, zeta: 0.75, steer: 70,
          nose: { x: 23.1, z: 4.8, r: 0.54, wheels: 2 }, main: [{ x: -2.5, y: -4.9, z: 4.8, r: 0.66, wheels: 4 }, { x: -2.5, y: 4.9, z: 4.8, r: 0.66, wheels: 4 }] },
        strike: [[-24, 0, 0.6, 'tail'], [-11, -30, -1.0, 'tip'], [-11, 30, -1.0, 'tip'], [4.5, -9.9, 3.95, 'nacelle'], [4.5, 9.9, 3.95, 'nacelle'], [30, 0, 1.2, 'nose'], [0, 0, 2.9, 'belly'], [-12, 0, 2.6, 'belly']],
        Ixx: 1.8e7, Iyy: 2.5e7, Izz: 3.9e7, gearVmax: 4.6, nMax: 2.5, qMax: 4.5 * D, pMax: 12 * D, alphaMax: 13 * D },
      model: {
        kind: 'jet', L: 62.8, nose: 30.2, fus: { d: 5.77, h: 5.97, zc: 0.2, noseLen: 7.6, tailLen: 16, tailUp: 1.7, smoothNose: true },
        wing: { x: 7.4, y0: 2.8, span: 30.06, c0: 11.8, cK: 6.2, yK: 9.8, c1: 1.6, sweep: 32, dih: 6, z: 1.7, t: 0.14, tt: 0.1, twist: -4,
          flap: [3.0, 17.0, 0.28], ail: [17.5, 25.0, 0.2], spoil: [[4.5, 16.5]], tip: 'raked', slats: true, fairings: 4, flex: 1.8 },
        htail: { x: -22.5, span: 9.8, c0: 5.8, c1: 1.9, sweep: 35, dih: 7, z: -0.8, t: 0.1, elev: 0.3 },
        vtail: { x: -19.8, h: 9.2, c0: 8.8, c1: 3.0, sweep: 40, z: -2.3, t: 0.1, rud: 0.32 },
        engines: [{ type: 'fan', x: 6.0, y: -9.9, z: 2.3, d: 3.3, len: 6.6, pylon: 1.2, fanD: 2.85, style: 'chevron' }, { type: 'fan', x: 6.0, y: 9.9, z: 2.3, d: 3.3, len: 6.6, pylon: 1.2, fanD: 2.85, style: 'chevron' }],
        gear: { noseX: 23.1, mainX: -2.5, track: 4.9, bogie: 4 }, cockpit: { x: 26.8, z: -1.35, y: -0.6, style: 'boeing' },
        windows: { x0: 22.0, x1: -18.5, pitch: 0.81, z: -0.55, h: 0.47, doors: [24.5, 13.0, -3.0, -16.5] }, livery: { base: '#f7f7f5', tail: '#1d3557', stripe: '#b3261e', belly: '#dfe2e6', reg: 'N789BL' } },
    },
    // ------------------------------------------------------------------ Boeing 747-400
    { id: 'b744', name: 'Boeing 747-400', short: '747-400', maker: 'Boeing', cat: 'Wide-body jet',
      blurb: 'The Queen of the Skies: four engines, the upper-deck hump and a 64 m wing with winglets. 400 t at takeoff.',
      facts: ['Span 64.4 m', '4 × 252 kN', 'Cruise M 0.855', 'MTOW 397 t'],
      v: { r: 165, v2: 175, ref: 150, app: 155, cruise: 490, fe: [280, 260, 240, 230, 205, 180], le: 270, mo: 365, mmo: 0.92, ceil: 45100, cruiseAlt: 35000, s1: 160 },
      fdm: {
        mass: 330000, S: 541.2, b: 64.44, c: 8.32, e: 0.92, CD0: 0.0195,
        CL0: 0.21, CLa: 5.7, CLmax: 1.35, CLq: 5.4, CLde: -0.338,
        Cm0: 0.02, Cma: -1.26, Cmq: -20.8, Cmde: 1.34,
        CYb: -0.96, CYdr: -0.175, Clb: -0.221, Clp: -0.45, Clr: 0.101, Clda: 0.12, Cldr: -0.007,
        Cnb: 0.15, Cnp: -0.121, Cnr: -0.3, Cnda: 0, Cndr: 0.109,
        maxElev: 25 * D, maxAil: 25 * D, maxRud: 25 * D,
        flaps: [F('UP', 0, 0, 0, 0, 0), F('1', 0, 20, 0.1, 0.4, 0.005), F('5', 5, 20, 0.25, 0.6, 0.012), F('10', 10, 20, 0.38, 0.72, 0.02), F('20', 20, 20, 0.52, 0.82, 0.03, -0.03),
          F('25', 25, 20, 0.65, 0.87, 0.045, -0.05), F('30', 30, 20, 0.8, 0.9, 0.06, -0.07)],
        flapTime: 8, retract: true, gearTime: 12, gearCD: 0.016, spoilerCL: 0.35, spoilerCD: 0.06, mcrit: 0.8, CDwave: 0.08,
        engines: [{ type: 'fan', thrust: 252000, x: 1.6, y: -21.0, z: 1.9 }, { type: 'fan', thrust: 252000, x: 6.1, y: -12.0, z: 2.5 },
          { type: 'fan', thrust: 252000, x: 6.1, y: 12.0, z: 2.5 }, { type: 'fan', thrust: 252000, x: 1.6, y: 21.0, z: 1.9 }],
        thrustLine: 0, wingZ: 2.0,
        gearLayout: { comp: 0.3, stroke: 0.6, zeta: 0.75, steer: 70,
          nose: { x: 24.0, z: 5.4, r: 0.62, wheels: 2 },
          main: [{ x: -1.5, y: -5.5, z: 5.4, r: 0.63, wheels: 4 }, { x: -1.5, y: 5.5, z: 5.4, r: 0.63, wheels: 4 }, { x: -4.0, y: -1.9, z: 5.4, r: 0.63, wheels: 4 }, { x: -4.0, y: 1.9, z: 5.4, r: 0.63, wheels: 4 }] },
        strike: [[-27, 0, 0.4, 'tail'], [-15, -32.2, -1.2, 'tip'], [-15, 32.2, -1.2, 'tip'], [0, -21, 3.9, 'nacelle'], [0, 21, 3.9, 'nacelle'], [4.6, -12, 4.4, 'nacelle'], [4.6, 12, 4.4, 'nacelle'], [32, 0, 1.4, 'nose'], [0, 0, 3.2, 'belly'], [-14, 0, 2.8, 'belly']],
        Ixx: 2.84e7, Iyy: 5.16e7, Izz: 7.75e7, gearVmax: 4.6, nMax: 2.5, qMax: 4 * D, pMax: 12 * D, alphaMax: 13 * D },
      model: {
        kind: 'jet', L: 70.6, nose: 33.5, fus: { d: 6.5, h: 7.85, zc: 0.4, noseLen: 9, tailLen: 17, tailUp: 2.0, hump: { x0: 33.5, x1: 10.5, h: 2.1 } },
        wing: { x: 6.2, y0: 3.2, span: 32.2, c0: 14.2, cK: 9.0, yK: 10.5, c1: 3.9, sweep: 37.5, dih: 7, z: 2.0, t: 0.13, tt: 0.08, twist: -3.5,
          flap: [3.5, 20.0, 0.28], ail: [21.0, 29.0, 0.2], spoil: [[5, 19.5]], tip: 'winglet', slats: true, fairings: 4 },
        htail: { x: -25.2, span: 11.0, c0: 7.2, c1: 2.4, sweep: 37, dih: 7, z: -1.2, t: 0.1, elev: 0.3 },
        vtail: { x: -21.8, h: 10.2, c0: 10.5, c1: 3.4, sweep: 45, z: -3.0, t: 0.1, rud: 0.3 },
        engines: [{ type: 'fan', x: 1.6, y: -21.0, z: 1.9, d: 2.8, len: 5.9, pylon: 1.2, fanD: 2.37, style: 'long' }, { type: 'fan', x: 6.1, y: -12.0, z: 2.5, d: 2.8, len: 5.9, pylon: 1.2, fanD: 2.37, style: 'long' },
          { type: 'fan', x: 6.1, y: 12.0, z: 2.5, d: 2.8, len: 5.9, pylon: 1.2, fanD: 2.37, style: 'long' }, { type: 'fan', x: 1.6, y: 21.0, z: 1.9, d: 2.8, len: 5.9, pylon: 1.2, fanD: 2.37, style: 'long' }],
        gear: { noseX: 24.0, mainX: -1.5, track: 5.5, bogie: 4, body: { x: -4.0, y: 1.9 } }, cockpit: { x: 29.4, z: -3.15, y: -0.55, style: 'boeing' },
        windows: { x0: 27.5, x1: -21.0, pitch: 0.508, z: -0.2, doors: [28.5, 19.0, 6.0, -5.5, -16.5], upper: { x0: 31.5, x1: 13.5, z: -3.7 } },
        livery: { base: '#f7f7f5', tail: '#b3261e', stripe: '#1d3557', belly: '#dfe2e6', reg: 'N744BL' } },
    },
    // ------------------------------------------------------------------ F-16C
    { id: 'f16', name: 'F-16C Fighting Falcon', short: 'F-16C', maker: 'General Dynamics / Lockheed Martin', cat: 'Fighter',
      blurb: 'Relaxed-stability, fly-by-wire fighter with a bubble canopy: 9 g, Mach 2 at altitude, 300°/s roll. Afterburner: throttle past 100 %.',
      facts: ['Span 9.45 m', '76 / 129 kN (AB)', 'Mach 2.05', '9 g'],
      v: { r: 150, ref: 145, app: 150, cruise: 480, fe: [300], le: 300, mo: 800, mmo: 2.05, ceil: 50000, cruiseAlt: 25000, s1: 125 },
      fdm: {
        mass: 12000, S: 27.87, b: 9.45, c: 3.45, e: 0.72, CD0: 0.0175,
        CL0: 0.0, CLa: 3.6, CLmax: 1.8, CLq: 3.0, CLde: -0.3,
        Cm0: 0.0, Cma: -0.25, Cmq: -5.0, Cmde: 0.6,
        CYb: -1.1, CYdr: -0.1, Clb: -0.1, Clp: -0.35, Clr: 0.05, Clda: 0.08, Cldr: -0.005,
        Cnb: 0.18, Cnp: -0.02, Cnr: -0.4, Cnda: -0.005, Cndr: 0.07,
        maxElev: 25 * D, maxAil: 21.5 * D, maxRud: 30 * D,
        flaps: [F('AUTO', 0, 0, 0, 0, 0), F('LDG', 20, 15, 0.3, 0.25, 0.03, -0.02)],
        flapTime: 2, retract: true, gearTime: 5, gearCD: 0.02, spoilerCL: 0.02, spoilerCD: 0.08, mcrit: 0.85, CDwave: 0.028, waveDecay: 0.5,
        engines: [{ type: 'fan', thrust: 76300, ab: 129400, ram: 0.5, abRam: 0.9, fast: true, x: -4.0, y: 0, z: 0.15 }],
        thrustLine: 0, wingZ: 0.3,
        gearLayout: { comp: 0.12, stroke: 0.3, zeta: 0.75, steer: 32,
          nose: { x: 3.4, z: 1.75, r: 0.3, wheels: 1 }, main: [{ x: -0.6, y: -1.18, z: 1.75, r: 0.38, wheels: 1 }, { x: -0.6, y: 1.18, z: 1.75, r: 0.38, wheels: 1 }] },
        strike: [[-7.0, 0, -0.15, 'tail'], [-2.5, -4.7, 0.2, 'tip'], [-2.5, 4.7, 0.2, 'tip'], [2.8, 0, 1.2, 'nose'], [7.5, 0, 0.3, 'nose'], [0, 0, 1.0, 'belly']],
        Ixx: 16600, Iyy: 97600, Izz: 110300, gearVmax: 4.0, nMax: 9, qMax: 25 * D, pMax: 300 * D, alphaMax: 25 * D, fbw: 'fighter' },
      model: {
        kind: 'fighter', L: 15.06, nose: 7.8, fus: { w: 1.5, h: 1.55, zc: 0.1 },
        wing: { x: 1.3, y0: 1.0, span: 4.72, c0: 5.0, c1: 1.1, sweep: 40, dih: 0, z: 0.25, t: 0.04, tt: 0.04, twist: 0,
          flap: [1.0, 3.2, 0.3], ail: null, spoil: null, tip: 'rail', lex: true },
        htail: { x: -5.4, span: 2.75, c0: 2.4, c1: 0.9, sweep: 40, dih: -10, z: 0.1, t: 0.04, elev: 1.0, allMoving: true },
        vtail: { x: -4.3, h: 3.0, c0: 3.4, c1: 1.2, sweep: 47, z: -0.75, t: 0.05, rud: 0.3 },
        engines: [{ type: 'jet', x: -6.4, y: 0, z: 0.15, d: 1.18, nozzle: true, intake: { x: 4.6, z: 0.95 } }],
        gear: { noseX: 3.4, mainX: -0.6, track: 1.18 }, cockpit: { x: 4.3, z: -0.95, y: 0, style: 'fighter' },
        windows: { style: 'fighter' }, livery: { base: '#8e969e', tail: '#6f777f', stripe: '#5d656d', belly: '#a3abb3', reg: 'BL 016' } },
    },
  ];
  const byId = {};
  for (const a of list) {
    const f = a.fdm;
    f.AR = f.b * f.b / f.S;
    f.gear = gearLegs(f.mass, f.gearLayout);
    f.strike = f.strike.map(s => ({ x: s[0], y: s[1], z: s[2], kind: s[3] }));
    // CG height above the ground at rest (gear at static compression)
    f.cgHeight = f.gearLayout.main[0].z - f.gearLayout.comp;
    // attitude at rest: the line from the main gear to the nose gear (compressed alike)
    f.restPitch = Math.atan2(f.gearLayout.main[0].z - f.gearLayout.nose.z, f.gearLayout.nose.x - f.gearLayout.main[0].x);
    byId[a.id] = a;
  }
  // reference landing speed (kt): 1.23 x the 1-g stall speed in the landing configuration (1.3 x for light aircraft)
  function vref(a, mass, notch) {
    const f = a.fdm, fl = f.flaps[notch === undefined ? f.flaps.length - 1 : notch];
    const vs = Math.sqrt(2 * (mass || f.mass) * G / (1.225 * f.S * (f.CLmax + fl.dCLmax)));
    return vs * (f.retract ? 1.23 : 1.3) / 0.514444;
  }
  function vstall(a, mass, notch) { const f = a.fdm, fl = f.flaps[notch || 0]; return Math.sqrt(2 * (mass || f.mass) * G / (1.225 * f.S * (f.CLmax + fl.dCLmax))) / 0.514444; }
  return { list, byId, vref, vstall };
})();
