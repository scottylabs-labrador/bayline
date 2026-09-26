// Bayline Metro: the switch, the boot gate and failure isolation (sim workstream; the contract is in notes/bart/sim.md,
// "Metro switch and failure isolation").
//
// The switch: every metro module reads Metro.on (never the URL itself), so turning the metro on for every visitor is the
// one line DEFAULT_ON below. #metro=1 / #metro=0 force it on or off.
//
// The boot gate: no metro data is requested and nothing metro is built before the first frame is on screen. 90_main.js
// calls Metro.arm() before it boots (MetroNet's loads wait on the gate) and Metro.start() after the first frame.
//
// Failure isolation: a 404 or parse error on any metro file, or an exception in a metro module (the gate's guards wrap
// every entry point: the main loop's metro calls, MetroNet's loads, MetroTrack/MetroStations/Under, the metro terrain
// filters and building drops, MetroKit), calls Metro.fail(): one console warning, the metro is off for the rest of the
// session, and every piece of it is taken down (scene objects removed, the underground engine switched off, terrain
// filters and keep-outs lifted and the world tiles they touched rebuilt), so the game carries on as without the metro.
//
// QA fault injection: #metrofail=net|tracks|tt|build|stations|kit|sim|ground|under (comma-separated) breaks that part on
// purpose: net / tracks / tt a real 404 or a corrupt binary, the others an exception a moment after they start working.
const Metro = (() => {
  const DEFAULT_ON = true;                                     // M3 (ship): true, and Bayline Metro is on for everyone
  const hash = (() => { try { return new URLSearchParams(location.hash.slice(1)); } catch (e) { return new URLSearchParams(); } })();
  const forced = hash.get('metro');
  let on = forced === null ? DEFAULT_ON : forced !== '0';
  const faults = new Set((hash.get('metrofail') || '').split(',').map(s => s.trim()).filter(Boolean));
  const skips = new Set((hash.get('metroskip') || '').split(',').map(s => s.trim()).filter(Boolean));   // (QA: memory per module)
  let failed = null, armed = false, started = false;
  const waiting = [], teardowns = [], listeners = [];
  const NEVER = new Promise(() => {});                         // what a failed metro load resolves to: callers just stop
  const whenStarted = () => started ? Promise.resolve() : new Promise(r => waiting.push(r));
  const q = (f) => { try { f(); } catch (e) { /* teardown keeps going */ } };

  // ---------------------------------------------------------------- failure
  function fail(where, err) {
    if (!on) return; on = false;
    failed = { where, message: String((err && err.message) || err || '') };
    console.warn(`Bayline Metro is off for this session: ${where} failed (${failed.message}). The rest of the game is unaffected.`);
    for (const f of teardowns) q(f);
    for (const f of listeners) q(() => f(failed));
  }
  // run a metro entry point; an exception turns the metro off instead of breaking the frame
  function guard(where, fn) { if (!on) return undefined; try { return fn(); } catch (e) { fail(where, e); return undefined; } }
  // wrap an API's functions so a throw turns the metro off (callers get undefined) instead of breaking the frame
  function guardAll(obj, where, names) {
    for (const k of names || Object.keys(obj)) { const f = obj[k]; if (typeof f !== 'function') continue;
      obj[k] = function (...a) { if (!on) return undefined; try { return f.apply(this, a); } catch (e) { fail(where, e); return undefined; } }; }
    return obj;
  }
  const fault = (k) => faults.has(k);
  function injected(k) { const e = new Error('injected fault (#metrofail=' + k + ')'); e.injected = true; return e; }

  // ---------------------------------------------------------------- the gate (installed before the game boots)
  let origAddFilter = null; const filterRects = [];
  const noopFilter = () => {};
  function arm() {
    if (armed || !on) return; armed = true;
    // MetroNet: its loads wait for the first frame; a failed load (404, parse error) turns the metro off and leaves every
    // caller waiting quietly (MetroTrack, MetroStations, MetroGround and MetroSim just never start)
    if (typeof MetroNet !== 'undefined' && MetroNet.load) {
      const load = MetroNet.load, loadTT = MetroNet.loadTimetable;
      let pNet = null, pTT = null;
      MetroNet.load = function (opts = {}) {
        if (!on) return NEVER;
        return pNet || (pNet = whenStarted().then(() => {
          if (fault('net')) opts = Object.assign({}, opts, { dir: 'metro-missing/' });
          return load.call(MetroNet, opts);
        }).then(r => r, e => { fail('the metro network data', e); return NEVER; }));
      };
      MetroNet.loadTimetable = function (...a) {
        if (!on) return NEVER;
        return pTT || (pTT = MetroNet.load().then(() => fault('tt') ? Stream.json('metro/timetable-missing.json', 4) : loadTT.apply(MetroNet, a))
          .then(r => r, e => { fail('the metro timetable', e); return NEVER; }));
      };
      if (fault('tracks') && typeof Stream !== 'undefined' && Stream.bin) {
        const bin = Stream.bin;
        Stream.bin = function (path, ...a) { return /(^|\/)metro[^/]*\/tracks/.test(path) ? Promise.resolve(new Uint8Array(4096)) : bin.call(Stream, path, ...a); };
      }
    }
    // terrain height filters and building drops added by metro modules: inert once the metro is off, an exception
    // turns it off, and their rectangles are remembered so those tiles can load again without them
    if (typeof Terrain !== 'undefined' && Terrain.addHeightFilter) {
      origAddFilter = Terrain.addHeightFilter;
      let n = 0;
      Terrain.addHeightFilter = function (fn, rect) {
        if (!on) return;
        if (rect) filterRects.push(rect.slice());
        return origAddFilter.call(Terrain, function (L, x, z, T, h) {
          if (!on) return;
          try { if (fault('ground') && ++n > 3) throw injected('ground'); fn(L, x, z, T, h); } catch (e) { fail('the metro ground shaping', e); }
        }, rect);
      };
    }
    if (typeof Towns !== 'undefined' && Towns.addDrop) {
      const addDrop = Towns.addDrop;
      Towns.addDrop = function (fn) { if (!on) return; return addDrop.call(Towns, function (b, x, z) { if (!on) return false; try { return fn(b, x, z); } catch (e) { fail('the metro building drops', e); return false; } }); };
    }
    // guideway (infra)
    if (typeof MetroTrack !== 'undefined' && MetroTrack.enabled) {
      const init = MetroTrack.init, update = MetroTrack.update; let n = 0;
      MetroTrack.init = function (...a) { if (!on || skips.has('track')) return; let p; try { p = init.apply(this, a); } catch (e) { fail('the guideway', e); return; } if (p && p.catch) p.catch(e => fail('the guideway', e)); return p; };
      MetroTrack.update = function (...a) { if (!on) return; if (fault('build') && started && ++n > 150) throw injected('build'); return update.apply(this, a); };
    }
    // stations (stations workstream): their hooks on Stations.init/update call these properties; the wrappers never throw
    if (typeof MetroStations !== 'undefined' && MetroStations.enabled) {
      const init = MetroStations.init, update = MetroStations.update; let n = 0;
      MetroStations.init = function (...a) { if (!on || skips.has('stations')) return; let p; try { p = init.apply(this, a); } catch (e) { fail('the stations', e); return; } if (p && p.catch) p.catch(e => fail('the stations', e)); return p; };
      MetroStations.update = function (...a) {
        if (!on) return;
        try { if (fault('stations') && started && MetroStations.ready && ++n > 150) throw injected('stations'); return update.apply(this, a); } catch (e) { fail('the stations', e); }
      };
      for (const k of ['floorAt', 'blocked', 'spawnPoint', 'setBoard']) {
        const f = MetroStations[k]; if (typeof f !== 'function') continue;
        MetroStations[k] = function (...a) { if (!on) return k === 'blocked' ? false : null; try { return f.apply(this, a); } catch (e) { fail('the stations', e); return k === 'blocked' ? false : null; } };
      }
    }
    // underground engine (infra): the main loop guards update / preRender / postRender; this only injects the fault
    if (fault('under') && typeof Under !== 'undefined' && Under.enabled) {
      const update = Under.update; let n = 0;
      Under.update = function (...a) { if (started && ++n > 150) throw injected('under'); return update.apply(this, a); };
    }
    // trains (MetroKit): a model that throws turns the metro off (MetroSim calls createConsist inside its own guard)
    if (fault('kit') && typeof MetroKit !== 'undefined' && MetroKit.createConsist) {
      MetroKit.createConsist = function () { throw injected('kit'); };
      if (MetroKit.createFarBatch) MetroKit.createFarBatch = function () { throw injected('kit'); };
    }
    teardowns.push(tearDownWorld);
  }
  // once the first frame is on screen: the metro may load and build
  function start() { if (started) return; started = true; for (const r of waiting.splice(0)) r(); }

  // ---------------------------------------------------------------- taking the metro down (public APIs only)
  function tearDownWorld() {
    // underground engine: no cells, cuts or portals, its switch off (every lit material and the terrain's cut test read
    // blUMK.x), anything it hid shown again, the post pipeline back to the open air
    if (typeof Under !== 'undefined' && Under.enabled) {
      for (const m of [Under.portals, Under.cuts, Under.cells]) if (m && m.keys) for (const id of [...m.keys()]) q(() => Under.remove(id));
      q(() => Under.postRender());
      q(() => { const K = THREE.ShaderLib.standard.uniforms.blUMK; if (K && K.value && K.value.set) K.value.set(0, 0, 0, 0); });
      q(() => { if (typeof Post !== 'undefined' && Post.under) { Post.under.depth = 0; Post.under.outside = true; } });
      q(() => { if (typeof Terrain !== 'undefined') Terrain.cutTest = null; });
    }
    // guideway and stations out of the scene; the stations' keep-outs lifted
    q(() => { if (typeof MetroTrack !== 'undefined' && MetroTrack.group && MetroTrack.group.parent) MetroTrack.group.parent.remove(MetroTrack.group); });
    q(() => { if (typeof MetroStations === 'undefined') return;
      if (MetroStations.group && MetroStations.group.parent) MetroStations.group.parent.remove(MetroStations.group);
      MetroStations.keepOut = () => false; MetroStations.keepOutAny = () => false; });
    // the places the metro reshaped (MetroGround's and the stations' rectangles, and every rectangle a metro height
    // filter was added with) come back natural: their height tiles re-stream through the now-inert filters
    // (Terrain.reloadHeights), and only their towns and tree tiles rebuild (Towns.refresh / Flora.reloadIn: the drop
    // filters and keep-outs are inert now), so there is no whole-city rebuild; older builds without those APIs fall back
    // to a no-op filter over each rectangle and full rebuilds
    const R = [].concat((typeof MetroGround !== 'undefined' && MetroGround.rects) || [], (typeof MetroStations !== 'undefined' && MetroStations.rects) || [], filterRects);
    q(() => { if (typeof Terrain === 'undefined') return;
      if (Terrain.reloadHeights) for (const r of R) q(() => Terrain.reloadHeights(r)); else if (origAddFilter) for (const r of filterRects) q(() => origAddFilter.call(Terrain, noopFilter, r)); });
    q(() => { if (typeof Towns === 'undefined') return; if (Towns.refresh) Towns.refresh(R); else if (Towns.dispose) Towns.dispose(); });
    q(() => { if (typeof Flora === 'undefined') return; if (Flora.reloadIn) Flora.reloadIn(R); else if (Flora.dispose) Flora.dispose(); });
    q(() => { if (typeof GroundCover !== 'undefined' && GroundCover.dispose) GroundCover.dispose(); });
  }

  const api = {
    get on() { return on; }, get failed() { return failed; }, get started() { return started; }, DEFAULT_ON,
    arm, start, fail, guard, guardAll, fault, injected, whenStarted, skip: (k) => skips.has(k),
    onTeardown(f) { teardowns.push(f); }, onFail(f) { listeners.push(f); },
  };
  if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).Metro = api;
  return api;
})();
