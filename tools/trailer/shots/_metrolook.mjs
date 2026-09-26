// TRAINS' looks for metro shot modules (page-side function sources, like _lib.mjs / _metro.mjs). MetroKit.look() holds
// the settings (see src/js/42_metrokit_cine.js); these presets add the exposure a shot wants.
//   cabLook(key, o): the D cab at night (P16 p_tube_cab): a fixed exposure (the eye adaptation would pump with every
//   tunnel light), the cab light nearly off, the screens a little brighter, and the cab mirrored in the windscreen at
//   its physical strength (the cab door's window onto the lit saloon behind, the console lit by its screens). Then a
//   short pre-roll in capture mode with the clock held: a few frames drawn from the cab eye (MetroKit builds interiors,
//   picks levels of detail and chooses glazing for the camera the cars were last drawn with, so the first captured
//   frame already has the cab's desk and screens); capture mode stays on, so the game's own loop doesn't draw the free
//   camera (clamped above the ground, outside the train) before the first captured frame. Needs __m (_metro.mjs) and
//   __cine installed; await it at the end of prime. o: { expo, lcd, refl, cab, frames (pre-roll) } overrides.
//   Resolves to the settings (a string) for the capture log.
export const cabLook = `async (key, o = {}) => { const B = window.__bayline; if (!B || !B.MetroKit || !B.MetroKit.look) return 'cabLook: no MetroKit.look in this build';
  if (B.Post) { B.Post.debug.ae = false; B.Post.debug.expo = o.expo ?? 1.5; }
  const L = B.MetroKit.look({ lcd: o.lcd ?? 1.9, refl: o.refl ?? 1.0, cab: o.cab ?? 0.03 });
  const M = window.__m, C = window.__cine, t = B.Env.time.sec;
  if (M && C && B.capture && B.stepFrame) {
    const at = (c) => ({ x: c.p.x + c.fwd.x * 40, y: c.p.y - 3, z: c.p.z + c.fwd.z * 40 });
    B.capture.cam = (tt, cam) => { const c = M.cab(key, 0, 0, 0.1); if (c) C.aim(cam, c.p, at(c), 50, 0); };
    B.capture.on = true;
    for (let i = 0; i < (o.frames ?? 8); i++) { B.Env.setClock(t); const c = M.cab(key, 0, 0, 0.1);
      if (c) { C.put(c.p, at(c)); if (B.MetroKit.viewHint) B.MetroKit.viewHint(c.p, 50); } B.stepFrame(1); await new Promise(r => setTimeout(r, 30)); }
  }
  B.Env.setClock(t);
  return 'cabLook ' + JSON.stringify(Object.assign({ expo: B.Post ? B.Post.debug.expo : null }, L)); }`;
