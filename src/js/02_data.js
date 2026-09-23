// Core data files (track, timetable, 64 m fallback terrain, ...). v2 streams them from DATA/core/ through
// Stream; older single-file builds (blob-NAME script tags) and preview pages (window.BAYLINE_DATA_BASE)
// still work.
const Data = (() => {
  const cache = new Map();
  function b64(str) { const bin = atob(str.trim()); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  async function inflate(u8) { const ds = new DecompressionStream('deflate'); const s = new Blob([u8]).stream().pipeThrough(ds); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function legacy(name, ext) {
    const el = document.getElementById('blob-' + name + (ext === '.json' ? '.json' : ''));
    if (el) return b64(el.textContent);
    if (window.BAYLINE_DATA_BASE) { const r = await fetch(window.BAYLINE_DATA_BASE + name + ext); if (!r.ok) throw new Error('missing data ' + name + ext); return new Uint8Array(await r.arrayBuffer()); }
    return null;
  }
  // Binary file (zlib inside): resolves to the decompressed bytes.
  function bin(name) {
    if (!cache.has(name)) cache.set(name, (async () => { const u = await legacy(name, '.bin'); return u ? inflate(u) : Stream.bin('core/' + name + '.bin', 0); })());
    return cache.get(name);
  }
  function json(name) {
    const k = name + '#json';
    if (!cache.has(k)) cache.set(k, (async () => { const u = await legacy(name, '.json'); return u ? JSON.parse(new TextDecoder().decode(u)) : Stream.json('core/' + name + '.json', 0); })());
    return cache.get(k);
  }
  return { bin, json };
})();
