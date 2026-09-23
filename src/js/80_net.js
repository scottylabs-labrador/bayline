// Net: optional multiplayer presence. Talks to server/mp.py through nginx at /ws (same origin).
// The train world is deterministic from the wall clock, so only tiny presence records travel:
// mode, trip, track position, car, local/world position, heading, speed. Players cannot send text;
// names are callsigns derived from a server-assigned id. Everything here is a no-op when offline,
// opened from file://, or when the server refuses us, so single-player is never affected.
//
//   Net.connect(url?)       start (url defaults to wss://<host>/ws; file:// pages stay solo)
//   Net.setState(st)        call every frame; sends at most 2 Hz and only on meaningful change
//                           st = { mode, trip, s, car, x, y, z, yaw, speed }   mode: name or 0..6
//   Net.others()            interpolated peers: [{ id, name, color, mode, modeName, trip, s, car, x, y, z, yaw, speed, age }]
//   Net.status              { online, state, players, ping, id, name, color, text }
//   Net.onStatus(fn)        called whenever status.text changes
//   Net.disconnect()
const Net = (() => {
  // Callsign tables: MUST match server/mp.py.
  const ROLES = ['Conductor', 'Engineer', 'Dispatcher', 'Signalman', 'Brakeman', 'Navigator', 'Rider', 'Commuter'];
  const WORDS = ['Juniper', 'Heron', 'Poppy', 'Redwood', 'Pelican', 'Sequoia', 'Manzanita', 'Quail',
    'Egret', 'Coyote', 'Willow', 'Sycamore', 'Tule', 'Sparrow', 'Buckeye', 'Marina',
    'Cypress', 'Plover', 'Madrone', 'Otter', 'Bayleaf', 'Kestrel', 'Sage', 'Tamarack',
    'Lupine', 'Avocet', 'Laurel', 'Falcon', 'Toyon', 'Condor', 'Yarrow', 'Starling'];
  const COLORS = ['#e4572e', '#f3a712', '#29b6a4', '#4c8bf5', '#a560e8', '#e84393', '#7ac74f', '#f06543',
    '#2ec4b6', '#ffbf46', '#5c80bc', '#d65db1', '#56c596', '#ff7f51', '#3d9be9', '#c3d350'];
  const callsign = id => `${ROLES[id % 8]} ${WORDS[Math.floor(id / 8) % 32]} ${(id * 37) % 100}`;
  const colorOf = id => COLORS[(id * 7) % 16];
  const MODE_NAMES = ['menu', 'walk', 'ride', 'drive', 'fly', 'map', 'cab'];
  const MODE = Object.fromEntries(MODE_NAMES.map((n, i) => [n, i]));

  const SEND_MIN_MS = 500, HEARTBEAT_MS = 15000, PING_MS = 10000, HIDDEN_CLOSE_MS = 60000;
  const status = { online: false, state: 'idle', players: 0, ping: 0, id: 0, name: '', color: '', text: 'Solo' };
  let ws = null, url = null, enabled = false, attempt = 0, opened = false;
  let retryTimer = 0, tickTimer = 0, hiddenTimer = 0;
  let cur = null, lastSent = null, lastSendAt = -1e9, lastPingAt = 0, snapMs = 1000;
  const peers = new Map();
  const out = [];
  let statusCb = null;

  const now = () => performance.now();
  const fin = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
  const r = (v, d) => { const m = 10 ** d; return Math.round(v * m) / m; };

  function setText(state, text) {
    status.state = state; status.online = state === 'online'; status.text = text;
    if (statusCb) try { statusCb(status); } catch (e) { /* UI errors must not break networking */ }
  }
  function defaultUrl() {
    if (location.protocol === 'https:') return `wss://${location.host}/ws`;
    if (location.protocol === 'http:') return `ws://${location.host}/ws`;
    return null;
  }

  function connect(u) {
    if (enabled) return;
    if (typeof WebSocket === 'undefined') { setText('local', 'Solo'); return; }
    url = u || defaultUrl();
    if (!url) { setText('local', 'Solo (local file)'); return; }
    enabled = true; attempt = 0;
    document.addEventListener('visibilitychange', onVisibility);
    clearInterval(tickTimer); tickTimer = setInterval(tick, 1000);
    open();
  }

  function open() {
    clearTimeout(retryTimer);
    if (!enabled || ws) return;
    if (document.hidden) { setText('paused', 'Paused'); return; }
    setText('connecting', 'Connecting…');
    opened = false;
    try { ws = new WebSocket(url); } catch (e) { ws = null; schedule(30000, 'offline', 'Offline'); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { opened = true; attempt = 0; };
    ws.onmessage = onMessage;
    ws.onerror = () => {};
    ws.onclose = ev => onClose(ev.code);
  }

  function schedule(ms, state, text) {
    setText(state, text);
    clearTimeout(retryTimer);
    if (enabled) retryTimer = setTimeout(open, ms * (0.7 + Math.random() * 0.6));
  }

  async function probeFull() {
    // Handshake failed before opening: the server may be refusing us at the HTTP layer because it is full.
    try {
      const statsUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '/mp/stats');
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
      const s = await (await fetch(statsUrl, { signal: ctl.signal, cache: 'no-store' })).json(); clearTimeout(t);
      return s.connections >= s.max_connections;
    } catch (e) { return false; }
  }

  async function onClose(code) {
    ws = null; status.online = false; peers.clear(); out.length = 0;
    if (!enabled) { setText('idle', 'Solo'); return; }
    if (code === 4001) return schedule(120000, 'full', 'World is full, riding solo');
    if (code === 4003) return schedule(180000, 'full', 'Too many riders from your network');
    if (code === 4004 || code === 4008 || code === 4009) { enabled = false; setText('blocked', 'Multiplayer unavailable'); return; }
    if (code === 1000 && document.hidden) { setText('paused', 'Paused'); return; }
    if (code === 4010) return schedule(2000, 'connecting', 'Reconnecting…');
    attempt++;
    if (!opened && attempt >= 2 && await probeFull()) return schedule(120000, 'full', 'World is full, riding solo');
    schedule(Math.min(60000, 2000 * 2 ** Math.min(attempt, 5)), 'offline', attempt > 2 ? 'Offline, riding solo' : 'Reconnecting…');
  }

  function onVisibility() {
    if (document.hidden) {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => { if (ws && document.hidden) ws.close(1000, 'hidden'); }, HIDDEN_CLOSE_MS);
    } else {
      clearTimeout(hiddenTimer);
      if (enabled && !ws && (status.state === 'paused' || status.state === 'offline' || status.state === 'connecting')) { attempt = 0; open(); }
    }
  }

  function onMessage(ev) {
    if (typeof ev.data === 'string') {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hi') {
        status.id = m.id | 0; status.name = callsign(status.id); status.color = colorOf(status.id);
        snapMs = 1000 / (m.hz || 1);
        setText('online', 'Online');
        lastSent = null; lastSendAt = -1e9; send(true);
      } else if (m.t === 'po' && typeof m.c === 'number') {
        status.ping = Math.max(0, Math.round(now() - m.c));
      }
      return;
    }
    decode(ev.data);
  }

  function decode(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 1) return;
    const online = dv.getUint16(5, true), n = dv.getUint8(7);
    const t = now();
    let o = 8;
    for (let i = 0; i < n && o + 25 <= buf.byteLength; i++) {
      const id = dv.getUint16(o, true), mode = dv.getUint8(o + 2), car8 = dv.getUint8(o + 3);
      const s = dv.getFloat32(o + 4, true), x = dv.getFloat32(o + 8, true), y = dv.getFloat32(o + 12, true), z = dv.getFloat32(o + 16, true);
      const yaw = dv.getInt16(o + 20, true) / 10000, speed = dv.getInt16(o + 22, true) / 100, tl = dv.getUint8(o + 24);
      let trip = '';
      for (let k = 0; k < tl && o + 25 + k < buf.byteLength; k++) trip += String.fromCharCode(dv.getUint8(o + 25 + k));
      o += 25 + tl;
      if (id === status.id) continue;
      const car = car8 === 255 ? -1 : car8;
      let p = peers.get(id);
      if (!p) {
        p = { id, name: callsign(id), color: colorOf(id), mode, trip, car, t,
              a: { s, x, y, z, yaw, speed }, b: { s, x, y, z, yaw, speed },
              v: { id, name: callsign(id), color: colorOf(id), mode, modeName: MODE_NAMES[mode] || 'menu', trip, s, car, x, y, z, yaw, speed, age: 0 } };
        peers.set(id, p);
      } else {
        if (p.mode !== mode || p.trip !== trip || p.car !== car) {
          p.a = { s, x, y, z, yaw, speed };      // changed train or mode: jump, do not slide between trains
        } else {
          sample(p, t); const v = p.v; p.a = { s: v.s, x: v.x, y: v.y, z: v.z, yaw: v.yaw, speed: v.speed };
        }
        p.b = { s, x, y, z, yaw, speed }; p.mode = mode; p.trip = trip; p.car = car; p.t = t;
        p.v.mode = mode; p.v.modeName = MODE_NAMES[mode] || 'menu'; p.v.trip = trip; p.v.car = car;
      }
      p.seen = t;
    }
    for (const [id, p] of peers) if (t - p.seen > 2.5 * snapMs) peers.delete(id);
    status.players = online;
    setText('online', `Online · ${online} ${online === 1 ? 'rider' : 'riders'}`);
  }

  function sample(p, t) {
    const k = (t - p.t) / snapMs, a = p.a, b = p.b, v = p.v;
    if (k <= 1) {
      const q = Math.max(0, k);
      v.s = a.s + (b.s - a.s) * q; v.x = a.x + (b.x - a.x) * q; v.y = a.y + (b.y - a.y) * q; v.z = a.z + (b.z - a.z) * q;
      let dy = b.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); v.yaw = a.yaw + dy * q;
      v.speed = a.speed + (b.speed - a.speed) * q;
    } else {
      // Late snapshot: keep moving along the track at the last speed for up to 2 s, then hold.
      const extra = Math.min(k - 1, 2) * snapMs / 1000;
      v.s = b.s + b.speed * extra; v.x = b.x; v.y = b.y; v.z = b.z; v.yaw = b.yaw; v.speed = b.speed;
    }
    v.age = t - p.t;
  }

  function others() {
    const t = now(); out.length = 0;
    for (const p of peers.values()) { sample(p, t); out.push(p.v); }
    return out;
  }

  function setState(st) {
    if (!st) return;
    const mode = typeof st.mode === 'string' ? (MODE[st.mode] ?? 0) : (st.mode | 0);
    cur = {
      mode: Math.min(6, Math.max(0, mode)),
      trip: String(st.trip ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12),
      s: fin(st.s, -1000, 250000), car: Math.round(fin(st.car ?? -1, -1, 31)),
      x: fin(st.x, -250000, 250000), y: fin(st.y, -1000, 10000), z: fin(st.z, -250000, 250000),
      yaw: Math.atan2(Math.sin(fin(st.yaw, -100, 100)), Math.cos(fin(st.yaw, -100, 100))), speed: fin(st.speed, -200, 200),
    };
    if (st.car == null) cur.car = -1;
    send(false);
  }

  function changed(a, b) {
    if (!b) return true;
    if (a.mode !== b.mode || a.trip !== b.trip || a.car !== b.car) return true;
    if (Math.abs(a.s - b.s) > 2 || Math.abs(a.speed - b.speed) > 0.5) return true;
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    if (dx * dx + dy * dy + dz * dz > 0.16) return true;
    return Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw))) > 0.05;
  }

  function send(force) {
    if (!ws || ws.readyState !== 1 || !cur || status.state !== 'online') return;
    const t = now();
    if (t - lastSendAt < SEND_MIN_MS) return;
    if (!force && !changed(cur, lastSent) && t - lastSendAt < HEARTBEAT_MS) return;
    const c = cur;
    ws.send(JSON.stringify([1, c.mode, c.trip, r(c.s, 1), c.car, r(c.x, 2), r(c.y, 2), r(c.z, 2), r(c.yaw, 3), r(c.speed, 2)]));
    lastSent = { ...c }; lastSendAt = t;
  }

  function tick() {
    if (!ws || ws.readyState !== 1 || status.state !== 'online') return;
    send(false);
    const t = now();
    if (t - lastPingAt > PING_MS) { lastPingAt = t; ws.send(JSON.stringify([2, Math.round(t * 10) / 10])); }
  }

  function disconnect() {
    enabled = false; clearTimeout(retryTimer); clearTimeout(hiddenTimer); clearInterval(tickTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (ws) { try { ws.close(1000, 'bye'); } catch (e) { /* ignore */ } }
    ws = null; peers.clear(); out.length = 0; setText('idle', 'Solo');
  }

  return {
    connect, disconnect, setState, others, callsign, colorOf, MODE, MODE_NAMES,
    get status() { return status; },
    onStatus(fn) { statusCb = fn; },
  };
})();
