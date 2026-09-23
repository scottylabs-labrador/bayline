// World coordinates: meters. +X east, -Z north (so +Z south), +Y up, y = meters above sea level.
// Local tangent-plane projection centered near Mountain View; distortion < 0.1% across the corridor.
const Geo = (() => {
  const LAT0 = 37.40, LON0 = -122.10, MLAT = 110985.1, MLON = 88542.2;
  const ll2w = (lat, lon) => ({ x: (lon - LON0) * MLON, z: -(lat - LAT0) * MLAT });
  const w2ll = (x, z) => ({ lat: LAT0 - z / MLAT, lon: LON0 + x / MLON });
  return { LAT0, LON0, MLAT, MLON, ll2w, w2ll };
})();
