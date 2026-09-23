// Weather: the real weather where you fly (Open-Meteo, free for non-commercial use, CC BY 4.0). Current conditions at
// the camera / aircraft (refreshed every 10 minutes or 40 km): surface wind and gusts, winds aloft at 850 / 700 / 500 /
// 300 / 250 hPa, low / mid / high cloud cover, a cloud base from the temperature-dewpoint spread, visibility,
// temperature and precipitation. Drives the sky (cloud deck and its base, cirrus, haze) away from the Bay's own
// daily model and whenever you fly, and the wind the aircraft flies in (with gust turbulence).
//   Weather.now          latest conditions (or null)     Weather.windAt(altMsl, out) -> Vector3 (m/s, the air's motion)
//   Weather.fetchAt(lat, lon) -> promise                 Weather.update(dt)   per frame
//   Weather.text()       an ATIS-like summary
const Weather = (() => {
  const D = Math.PI / 180, KT = 0.514444, FT = 0.3048;
  const LEVELS = [[850, 1460], [700, 3010], [500, 5570], [300, 9160], [250, 10360]];   // pressure level, ~ISA height (m)
  let now = null, busy = null, lastAt = null, lastT = -1e9, enabled = true;
  const URL = (lat, lon) => 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3)
    + '&current=temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,precipitation,weather_code,pressure_msl'
    + '&hourly=' + LEVELS.map(([p]) => `wind_speed_${p}hPa,wind_direction_${p}hPa`).join(',') + '&forecast_days=1&wind_speed_unit=ms&timezone=GMT';
  function fetchAt(lat, lon) {
    if (busy) return busy;
    busy = fetch(URL(lat, lon), { mode: 'cors', credentials: 'omit' }).then(r => r.ok ? r.json() : Promise.reject(new Error('weather ' + r.status))).then(j => {
      const c = j.current, h = j.hourly, hr = new Date().getUTCHours();
      const i = Math.max(0, h.time.findIndex(t => +t.slice(11, 13) === hr));
      const aloft = LEVELS.map(([p, z]) => ({ z, s: h[`wind_speed_${p}hPa`][i] || 0, d: h[`wind_direction_${p}hPa`][i] || 0 }));
      const spread = Math.max(0, c.temperature_2m - c.dew_point_2m);
      now = { lat, lon, t: performance.now(), elev: j.elevation || 0, temp: c.temperature_2m, dew: c.dew_point_2m, qnh: c.pressure_msl,
        wind: { s: c.wind_speed_10m || 0, d: c.wind_direction_10m || 0, g: c.wind_gusts_10m || 0 }, aloft,
        low: (c.cloud_cover_low || 0) / 100, mid: (c.cloud_cover_mid || 0) / 100, high: (c.cloud_cover_high || 0) / 100, cover: (c.cloud_cover || 0) / 100,
        vis: c.visibility || 30000, precip: c.precipitation || 0, code: c.weather_code || 0,
        base: (j.elevation || 0) + U.clamp(125 * spread, 250, 2600) };
      lastAt = { lat, lon }; lastT = performance.now();
      return now;
    }).catch(e => { console.warn(e); lastT = performance.now() - 8 * 60000; return now; }).finally(() => { busy = null; });
    return busy;
  }
  // wind vector (where the air goes) at an altitude above sea level: surface wind in the lowest 300 m AGL
  // (with the log-law increase), then linear between the pressure levels
  const vec = (s, d, out) => out.set(-Math.sin(d * D) * s, 0, Math.cos(d * D) * s);
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function windAt(alt, out = new THREE.Vector3()) {
    if (!now) return out.set(0, 0, 0);
    const agl = Math.max(1, alt - now.elev), sw = now.wind;
    const pts = [{ z: now.elev + 300, s: sw.s * 1.35, d: sw.d + 10 }, ...now.aloft.filter(l => l.z > now.elev + 400)];
    if (alt <= pts[0].z) return vec(sw.s * U.clamp(Math.log(agl / 0.1) / Math.log(100), 0.25, 1.35), sw.d + 10 * Math.min(1, agl / 300), out);
    for (let k = 0; k + 1 < pts.length; k++) if (alt <= pts[k + 1].z) {
      const a = pts[k], b = pts[k + 1], t = (alt - a.z) / (b.z - a.z);
      vec(a.s, a.d, tmpA); vec(b.s, b.d, tmpB); return out.copy(tmpA).lerp(tmpB, t);
    }
    const l = pts[pts.length - 1]; return vec(l.s, l.d, out);
  }
  // the sky: live clouds / haze replace the Bay's daily model away from the Bay and whenever you fly
  function applySky() {
    if (typeof Sky === 'undefined' || !Sky.setLive) return;
    const flying = typeof Flight !== 'undefined' && Flight.active, away = typeof Globe !== 'undefined' && !Globe.frame.bay;
    if (!now || !(flying || away) || !enabled) { Sky.setLive(null); return; }
    const haze = U.clamp(26000 / Math.max(now.vis, 600), 1.15, 9);
    Sky.setLive({ clouds: U.clamp(now.low * 0.85 + now.mid * 0.35, 0, 0.92), cirrus: U.clamp(now.high * 0.8, 0, 0.85), haze, base: now.base,
      windDir: now.wind.d, windSpeed: Math.max(2, now.aloft[0] ? now.aloft[0].s : now.wind.s) });
  }
  function update(dt) {
    if (!enabled) return;
    const flying = typeof Flight !== 'undefined' && Flight.active, away = typeof Globe !== 'undefined' && !Globe.frame.bay;
    if (flying || away) {
      const p = flying ? Flight.ac.pos : Env.camera.position, ll = Globe.w2ll(p.x, p.z);
      const far = !lastAt || Math.hypot((ll.lat - lastAt.lat) * 111, (ll.lon - lastAt.lon) * 111 * Math.cos(ll.lat * D)) > 40;
      if (!busy && (far || performance.now() - lastT > 10 * 60000)) fetchAt(ll.lat, ll.lon);
    }
    applySky();
  }
  const cardinal = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((d % 360) + 360) % 360 / 45) % 8];
  function text() {
    if (!now) return '';
    const w = now.wind, cov = now.low > 0.85 ? 'overcast' : now.low > 0.55 ? 'broken' : now.low > 0.25 ? 'scattered' : now.low > 0.05 ? 'few' : 'no low';
    return `Wind ${String(Math.round(w.d / 10) * 10 % 360 || 360).padStart(3, '0')}° at ${Math.round(w.s / KT)} kt${w.g > w.s + 5 ? ' gusting ' + Math.round(w.g / KT) : ''}, visibility ${now.vis >= 10000 ? '10+ km' : (now.vis / 1000).toFixed(1) + ' km'}, ${cov} clouds${now.low > 0.05 ? ' at ' + Math.round((now.base - now.elev) / FT / 100) * 100 + ' ft' : ''}, ${Math.round(now.temp)}°C, QNH ${Math.round(now.qnh)}`;
  }
  return { fetchAt, windAt, update, text, cardinal, get now() { return now; }, set enabled(v) { enabled = !!v; }, get enabled() { return enabled; } };
})();
