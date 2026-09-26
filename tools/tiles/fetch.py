"""Cached, polite, parallel downloads for the tile bake: NAIP (USGS NAIPPlus ImageServer), USGS imagery
basemap tiles, AWS terrarium elevation tiles. Everything lands under data/raw/ and is reused on re-runs."""
import os, random, threading, time
import requests
from .common import RAW, log

UA = 'Bayline-rail-sim/2.0 (ScottyLabs student project; tile bake; contact via github.com/scottylabs-labrador/bayline)'
NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage'
USGS_TILE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

_local = threading.local()
STOP = threading.Event()
_stats = {'get': 0, 'bytes': 0, 'fail': 0}
_lock = threading.Lock()


def _session():
    s = getattr(_local, 's', None)
    if s is None:
        s = requests.Session()
        s.headers['User-Agent'] = UA
        _local.s = s
    return s


def get_cached(url, dest, min_bytes=100, tries=6, timeout=180, validate=None):
    """Download url to dest unless it already exists (atomic). Returns bytes. Raises after retries."""
    if os.path.exists(dest) and os.path.getsize(dest) >= min_bytes:
        with open(dest, 'rb') as f:
            return f.read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    delay = 2.0
    last = None
    for attempt in range(tries):
        if STOP.is_set():
            raise KeyboardInterrupt
        try:
            r = _session().get(url, timeout=timeout)
            if r.status_code == 200 and len(r.content) >= min_bytes and (validate is None or validate(r)):
                tmp = dest + f'.part{threading.get_ident()}'
                with open(tmp, 'wb') as f:
                    f.write(r.content)
                os.replace(tmp, dest)
                with _lock:
                    _stats['get'] += 1
                    _stats['bytes'] += len(r.content)
                return r.content
            last = f'HTTP {r.status_code} len {len(r.content)} ct {r.headers.get("content-type")}'
            if r.status_code == 404:
                break
        except requests.RequestException as e:
            last = repr(e)
        time.sleep(delay + random.random() * delay)
        delay = min(delay * 2, 60)
    with _lock:
        _stats['fail'] += 1
    raise IOError(f'download failed: {url} ({last})')


def stats():
    with _lock:
        return dict(_stats)


def naip(bbox, px, bands='rgb', quality=92, timeout=180):
    """NAIP export for a lon/lat bbox (w,s,e,n) at px*px. bands: 'rgb' or 'nir'. Returns JPEG bytes."""
    w, s, e, n = bbox
    extra = '&bandIds=3' if bands == 'nir' else ''
    url = (f'{NAIP}?bbox={w:.9f},{s:.9f},{e:.9f},{n:.9f}&bboxSR=4326&imageSR=4326&size={px},{px}'
           f'&format=jpg&compressionQuality={quality}&interpolation=RSP_BilinearInterpolation&adjustAspectRatio=false&f=image{extra}')
    # adjustAspectRatio=false: without it the server widens the lat extent to keep square pixels (tiles are square in
    # metres, not in degrees), which misregisters every tile by up to ~50 m. Cache dir 'naip_aar0' so old fetches are never reused.
    key = f'{w:.7f}_{s:.7f}_{e:.7f}_{n:.7f}_{px}_{bands}'
    dest = os.path.join(RAW, 'naip_aar0', bands, str(px), key.replace('-', 'm') + '.jpg')
    return get_cached(url, dest, min_bytes=500, timeout=timeout, validate=lambda r: r.headers.get('content-type', '').startswith('image/') and
                      (bands != 'rgb' or _rgb_ok(r.content)))


def _rgb_ok(b):
    """False when the ImageServer dropped a band in some block (magenta / yellow / cyan rectangles under load):
    get_cached then retries (tools/metro_world/naip_dropouts.py). A dropout block: one band all but zero while the
    other two look like bright, textured land (clear water, where red is near zero too, is smooth and darker)."""
    try:
        import io
        import numpy as np
        from PIL import Image
        im = Image.open(io.BytesIO(b)); im.draft('RGB', (max(64, im.size[0] // 8), max(64, im.size[1] // 8)))
        bad = rgb_dropout_array(np.asarray(im.convert('RGB')).astype(np.float32))
        if bad:
            log('NAIP band dropout in a response, retrying')
        return not bad
    except Exception:
        return True


def rgb_dropout_array(a, G=16):
    import numpy as np
    n = a.shape[0] // G
    if n < 2:
        return False
    B = a[:n * G, :n * G].reshape(G, n, G, n, 3).transpose(0, 2, 1, 3, 4).reshape(G, G, n * n, 3)
    hi = np.percentile(B, 98, axis=2); mean = B.mean(2); std = B.std(2)
    for c in range(3):
        o = [k for k in range(3) if k != c]
        if ((hi[..., c] < 6) & (mean[..., o].min(-1) > 40) & (std[..., o].min(-1) > 7)).any():
            return True
    return False
