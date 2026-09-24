#!/usr/bin/env node
// Headless flight-model QA: loads three.js and the aircraft / FDM / FCS modules into a Node vm and flies every type
// through a takeoff + climb, a cruise check and an autoland on flat ground. Prints liftoff distance and speed, climb,
// cruise Mach / thrust / L/D, maximum level speed, touchdown point, sink rate and stopping distance.
//   node tools/qa_flight.js [typeId]        e.g. node tools/qa_flight.js a320
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } }; ctx.window = ctx; ctx.self = ctx; vm.createContext(ctx);
ctx.console = { ...console, warn() {} }; vm.runInContext(fs.readFileSync(ROOT + '/vendor/three.min.js', 'utf8'), ctx); ctx.console = console;   // (quiet: the UMD build's deprecation notice)
vm.runInContext(['46_aircraft.js', '47_fcs.js', '47_fdm.js'].map(f => fs.readFileSync(ROOT + '/src/js/' + f, 'utf8')).join('\n') + '\n;globalThis.AIRCRAFT = AIRCRAFT; globalThis.FDM = FDM; globalThis.FCS = FCS;', ctx);
const { AIRCRAFT, FDM, FCS, THREE } = ctx, KT = 0.514444, FT = 0.3048, D = Math.PI / 180;
const flat = { h: 0 }, env = { ground: () => flat, wind: new THREE.Vector3() }, only = process.argv[2];
let fails = 0;
for (const T of AIRCRAFT.list) {
  if (only && T.id !== only) continue;
  const log = (m) => console.log(T.short.padEnd(8), m);
  // ---- takeoff and climb
  { const ac = FDM.create(T.fdm), f = FCS.create(ac, T); env.pre = f.pre;
    const toFlap = T.id === 'c172' ? 1 : T.id === 'f16' ? 0 : T.id === 'a320' ? 2 : 3;
    ac.place({ x: 0, y: 0, z: 0, hdg: 0, onGround: true, flaps: toFlap }); ac.settle(env);
    ac.ctl.thr = T.id === 'f16' ? 1.1 : 1; let t = 0, lo = null, rot = false, gearUp = false; const E = {};
    while (t < 120) { const o = ac.out; ac.euler(E);
      if (!rot && o.cas >= T.v.r * KT) { f.pil.pitch = 0.8; rot = true; }
      if (rot && !lo && E.pitch > (T.id === 'c172' ? 8 : 12) * D) f.pil.pitch = 0;
      if (!o.onGround && !lo && t > 2) { lo = { d: Math.hypot(ac.pos.x, ac.pos.z), kt: o.cas / KT }; f.pil.pitch = 0; }
      if (lo && !gearUp && ac.pos.y > 15) { ac.ctl.gear = 0; gearUp = true; }
      ac.step(1 / 60, env); t += 1 / 60; if (ac.out.crashed) { log('CRASH on takeoff: ' + ac.out.crashed); fails++; break; } }
    log(`takeoff: liftoff ${lo ? lo.d.toFixed(0) + ' m at ' + lo.kt.toFixed(0) + ' kt' : 'NONE'}; after 120 s ${(ac.pos.y / FT).toFixed(0)} ft, ${(ac.out.cas / KT).toFixed(0)} kt`); if (!lo) fails++; }
  // ---- cruise and maximum level speed
  { const ac = FDM.create(T.fdm), f = FCS.create(ac, T); env.pre = f.pre;
    const alt = T.v.cruiseAlt * FT, atm = FDM.atmosphere(alt), tas = T.id === 'c172' ? 62 : T.id === 'f16' ? 0.9 * atm.a : (T.v.mmo - 0.04) * atm.a;
    ac.place({ x: 0, y: alt, z: 0, hdg: 0, fpa: 0, speed: tas, thr: 0.7, gear: 0, flaps: 0 }); ac.gearPos = T.fdm.retract ? 0 : 1; f.airStart(0);
    f.ap.on = true; f.ap.alt = alt; f.ap.hdg = 0; f.ap.athr = true; f.ap.spd = FDM.cas(tas, atm) / KT; f.ap.thrI = 0.7;
    for (let t = 0; t < 240; t += 1 / 60) ac.step(1 / 60, env);
    const thrust = ac.eng.reduce((s, e) => s + e.thrust, 0);
    log(`cruise ${(ac.pos.y / FT).toFixed(0)} ft M${ac.out.mach.toFixed(3)} ${(ac.out.tas / KT).toFixed(0)} KTAS thrust lever ${ac.ctl.thr.toFixed(2)} L/D ${(ac.out.CL / (thrust / (ac.out.qbar * T.fdm.S))).toFixed(1)}`); }
  // ---- autoland from 10 nm
  { const ac = FDM.create(T.fdm), f = FCS.create(ac, T); env.pre = f.pre;
    const nF = T.fdm.flaps.length - 1, vapp = AIRCRAFT.vref(T) + 5, d = 18520;
    ac.place({ x: 60, y: d * Math.tan(3 * D) + T.fdm.cgHeight, z: d, hdg: 0, pitch: 1.5 * D, fpa: -3 * D, speed: vapp * KT, gear: 1, flaps: nF, thr: 0.45 }); f.airStart(-3 * D);
    f.ap.on = true; f.ap.appr = true; f.ap.rwy = { x: 0, z: 0, ux: 0, uz: -1, elev: 0, aim: 300 }; f.ap.athr = true; f.ap.spd = Math.round(vapp); f.ap.thrI = 0.45;
    let t = 0, td = null;
    while (t < 700) { const o = ac.out;
      if (!td && o.onGround && t > 5) { td = { past: -ac.pos.z, fpm: (o.touch ? -o.touch.vy : -o.vs) / FT * 60, kt: o.cas / KT, x: ac.pos.x }; ac.ctl.thr = 0; ac.ctl.rev = T.fdm.retract ? 1 : 0; ac.ctl.brake = 0.5; }
      if (td && o.gs < 15) ac.ctl.rev = 0; if (td && o.gs < 0.5) break;
      ac.step(1 / 60, env); t += 1 / 60; if (ac.out.crashed) { log('CRASH on autoland: ' + ac.out.crashed); fails++; break; } }
    if (td) log(`autoland: touchdown ${td.past.toFixed(0)} m past the threshold, ${td.x.toFixed(1)} m off centre, ${td.fpm.toFixed(0)} fpm, ${td.kt.toFixed(0)} kt; stopped ${(-ac.pos.z).toFixed(0)} m past`);
    else { log('autoland: no touchdown'); fails++; } }
}
if (fails) { console.log(fails + ' failure(s)'); process.exit(1); }
