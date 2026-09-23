"""Terrarium z11 mosaic -> height sampler in lat/lon (bilinear). Shared by the bake scripts."""
import os, math, numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Z, X0, X1, Y0, Y1 = 11, 326, 333, 791, 797
def load():
    W, H = (X1 - X0 + 1) * 256, (Y1 - Y0 + 1) * 256
    m = np.zeros((H, W), np.float32)
    for x in range(X0, X1 + 1):
        for y in range(Y0, Y1 + 1):
            a = np.asarray(Image.open(os.path.join(ROOT, f'data/raw/dem/11_{x}_{y}.png')).convert('RGB')).astype(np.float32)
            m[(y-Y0)*256:(y-Y0+1)*256, (x-X0)*256:(x-X0+1)*256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    return m
MOSAIC = None
def pix(lat, lon):
    n = 2 ** Z
    px = (np.asarray(lon) + 180) / 360 * n * 256 - X0 * 256
    lr = np.radians(np.asarray(lat))
    py = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * n * 256 - Y0 * 256
    return px, py
def sample(lat, lon):
    global MOSAIC
    if MOSAIC is None: MOSAIC = load()
    px, py = pix(lat, lon); H, W = MOSAIC.shape
    px = np.clip(px - 0.5, 0, W - 1.001); py = np.clip(py - 0.5, 0, H - 1.001)
    x0 = np.floor(px).astype(int); y0 = np.floor(py).astype(int); fx = px - x0; fy = py - y0
    m = MOSAIC
    return (m[y0, x0] * (1 - fx) * (1 - fy) + m[y0, x0 + 1] * fx * (1 - fy) + m[y0 + 1, x0] * (1 - fx) * fy + m[y0 + 1, x0 + 1] * fx * fy)
