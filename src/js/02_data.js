// Embedded data blobs. build.py writes each data/baked/<name>.bin (zlib-compressed) and <name>.json
// into <script type="application/octet-stream" id="blob-<name>"> tags as base64. During development
// (preview pages opened from the source tree) the same files are fetched from ../data/baked/.
const Data = (() => {
  const cache = new Map();
  function b64(str) { const bin = atob(str.trim()); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  async function raw(name, ext) {
    const el = document.getElementById('blob-' + name + (ext === '.json' ? '.json' : ''));
    if (el) return b64(el.textContent);
    const base = (window.BAYLINE_DATA_BASE || '../data/baked/');
    const r = await fetch(base + name + ext); if (!r.ok) throw new Error('missing data ' + name + ext);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function inflate(u8) { const ds = new DecompressionStream('deflate'); const s = new Blob([u8]).stream().pipeThrough(ds); return new Uint8Array(await new Response(s).arrayBuffer()); }
  // Binary blob (zlib inside): returns Uint8Array of the decompressed bytes.
  function bin(name) { if (!cache.has(name)) cache.set(name, raw(name, '.bin').then(inflate)); return cache.get(name); }
  // JSON blob (plain text JSON, stored base64 in the page).
  function json(name) { const k = name + '#json'; if (!cache.has(k)) cache.set(k, raw(name, '.json').then(u => JSON.parse(new TextDecoder().decode(u)))); return cache.get(k); }
  return { bin, json };
})();
