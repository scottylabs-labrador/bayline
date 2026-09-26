// TRAINS' looks for metro shot modules (page-side function sources, like _lib.mjs / _metro.mjs). MetroKit.look() holds
// the settings (see src/js/42_metrokit_cine.js); these presets add the exposure a shot wants.
//   cabLook(key, o): the D cab at night (P16 p_tube_cab): a fixed exposure (the eye adaptation would pump with every
//   tunnel light), the cab light nearly off, the screens a little brighter, and the cab mirrored in the windscreen at
//   its physical strength (the cab door's window onto the lit saloon behind, the console lit by its screens). Then a
//   short pre-roll: the clock held while the game draws a few frames from the cab eye (MetroKit builds interiors,
//   picks levels of detail and chooses glazing for the camera the cars were last drawn with, so the first captured
//   frame already has the cab's desk and screens). Needs __m (_metro.mjs) installed; await it at the end of prime.
//   o: { expo, lcd, refl, cab, preroll (ms) } overrides. Resolves to the settings (a string) for the capture log.
export const cabLook = `async (key, o = {}) => { const B = window.__bayline; if (!B || !B.MetroKit || !B.MetroKit.look) return 'cabLook: no MetroKit.look in this build';
  if (B.Post) { B.Post.debug.ae = false; B.Post.debug.expo = o.expo ?? 1.5; }
  const L = B.MetroKit.look({ lcd: o.lcd ?? 1.9, refl: o.refl ?? 1.0, cab: o.cab ?? 0.03 });
  const M = window.__m, C = window.__cine, t = B.Env.time.sec, t0 = performance.now();
  if (M && C) while (performance.now() - t0 < (o.preroll ?? 900)) { B.Env.setClock(t); const c = M.cab(key, 0, 0, 0.1);
    if (c) C.put(c.p, { x: c.p.x + c.fwd.x * 40, y: c.p.y, z: c.p.z + c.fwd.z * 40 }); await new Promise(r => setTimeout(r, 40)); }
  B.Env.setClock(t);
  return 'cabLook ' + JSON.stringify(Object.assign({ expo: B.Post ? B.Post.debug.expo : null }, L)); }`;
