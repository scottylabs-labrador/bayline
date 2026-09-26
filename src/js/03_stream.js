// Stream: the one network front door for streamed data (tiles, buildings, trees, core files).
// A priority queue with ≤ 8 requests in flight, de-duplication, cancellation, retries with backoff,
// zlib auto-inflate (DecompressionStream) and off-thread image decode (createImageBitmap).
//   Stream.bin(path, prio)            -> Promise<Uint8Array>   (inflated when the payload is zlib)
//   Stream.json(path, prio)           -> Promise<any>
//   Stream.image(path, prio)          -> Promise<ImageBitmap>
//   Stream.range(path, off, len, prio)-> Promise<Uint8Array>   (HTTP Range; inflated when zlib)
//   Stream.cancel(path)  Stream.prioritize(path, prio)  Stream.stats
// Paths are relative to DATA (window.BAYLINE_DATA || './data/v2/'); lower prio = sooner.
const Stream = (() => {
  const BASE = (typeof window !== 'undefined' && (window.BAYLINE_DATA || new URLSearchParams(location.hash.slice(1)).get('data'))) || './data/v2/';
  const MAX_ACTIVE = 10;           // HTTP/2 to the proxy: plenty of multiplexing headroom
  const queue = []; const jobs = new Map(); let active = 0;
  const stats = { requests: 0, bytes: 0, errors: 0, notFound: 0, cancelled: 0, get active() { return active; }, get queued() { return queue.length; } };
  // build.py stamps the build time here: every metadata URL (*.json: tile indexes, metro network/timetable, airports)
  // changes with each deploy, so no cache (browser or edge) can hand a new build an index older than its code.
  // Tiles themselves are immutable per path and stay unversioned.
  const VER = '__BUILD__';
  const ver = (u) => (VER.indexOf('BUILD') < 0 && /\.json$/.test(u.split('?')[0])) ? u + (u.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(VER) : u;
  const url = (p) => (/^(https?:)?\/\//.test(p) || p.startsWith('/') || p.startsWith('./') || p.startsWith('../')) ? p : ver(BASE + p);
  const isZlib = (u) => u.length > 2 && (u[0] & 0x0f) === 8 && (u[0] >> 4) <= 7 && ((u[0] << 8) | u[1]) % 31 === 0;
  async function inflate(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  function request(kind, path, prio = 5, range = null) {
    const key = kind + '|' + path + (range ? '|' + range[0] + '+' + range[1] : '');
    const have = jobs.get(key);
    if (have) { if (prio < have.prio) have.prio = prio; return have.promise; }
    const job = { key, kind, path, prio, range, tries: 0, ctrl: null, state: 'queued' };
    job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
    job.promise.catch(() => {});             // callers handle; never leak unhandled rejections
    jobs.set(key, job); queue.push(job); pump();
    return job.promise;
  }
  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      let bi = 0; for (let i = 1; i < queue.length; i++) if (queue[i].prio < queue[bi].prio) bi = i;
      const job = queue.splice(bi, 1)[0]; run(job);
    }
  }
  function finish(job, ok, value) {
    if (job.state === 'done') return; job.state = 'done'; jobs.delete(job.key);
    if (ok) job.resolve(value); else job.reject(value);
  }
  async function run(job) {
    active++; job.state = 'active'; job.ctrl = new AbortController(); stats.requests++;
    let retry = false;
    try {
      const init = { signal: job.ctrl.signal };
      if (job.range) init.headers = { Range: `bytes=${job.range[0]}-${job.range[0] + job.range[1] - 1}` };
      const r = await fetch(url(job.path), init);
      if (r.status === 404 || r.status === 410) { stats.notFound++; const e = new Error('404 ' + job.path); e.notFound = true; throw e; }
      if (!r.ok) { const e = new Error(r.status + ' ' + job.path); e.http = r.status; throw e; }
      const ct = r.headers.get('content-type') || '';
      if (ct.startsWith('text/html') && job.kind !== 'json') { const e = new Error('html instead of data ' + job.path); e.notFound = true; throw e; }  // SPA fallback guard
      let out;
      if (job.kind === 'json') out = await r.json();
      else if (job.kind === 'image') { const b = await r.blob(); stats.bytes += b.size; out = await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
      else { let u8 = new Uint8Array(await r.arrayBuffer()); stats.bytes += u8.length; if (isZlib(u8)) u8 = await inflate(u8); out = u8; }
      finish(job, true, out);
    } catch (e) {
      if (e && e.name === 'AbortError') { stats.cancelled++; finish(job, false, e); }
      else if (e && e.notFound) finish(job, false, e);
      else if (job.tries < 3 && job.state !== 'done') { job.tries++; retry = true; }
      else { stats.errors++; finish(job, false, e); }
    } finally {
      active--;
      if (retry) { job.state = 'queued'; setTimeout(() => { if (job.state === 'queued') { queue.push(job); pump(); } }, 350 * 2 ** job.tries); }
      pump();
    }
  }
  function cancel(path) {
    for (const [key, job] of jobs) {
      if (job.path !== path) continue;
      if (job.state === 'queued') { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); stats.cancelled++; const e = new Error('cancelled'); e.name = 'AbortError'; finish(job, false, e); }
      else if (job.state === 'active' && job.ctrl) job.ctrl.abort();
    }
  }
  function prioritize(path, prio) { for (const job of jobs.values()) if (job.path === path && prio < job.prio) job.prio = prio; }
  return {
    base: BASE, url, inflate, cancel, prioritize, stats,
    bin: (path, prio) => request('bin', path, prio),
    json: (path, prio) => request('json', path, prio),
    image: (path, prio) => request('image', path, prio),
    range: (path, off, len, prio) => request('bin', path, prio, [off, len]),
  };
})();
