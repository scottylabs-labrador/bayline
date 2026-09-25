#!/usr/bin/env python3
"""Bayline monitor: polls each deployment's multiplayer relay (/mp/stats), keeps the history in SQLite and
serves a small dashboard. Standard library only.

  SITES           label=url pairs, comma separated, e.g. "tkanz.com=https://bayline.tkanz.com,ScottyLabs=https://..."
  POLL_SECONDS    sampling interval (default 15)
  RAW_DAYS        how long raw samples are kept (default 14); hourly roll-ups are kept forever
  DB, PORT        /data/monitor.db, 8080
  MONITOR_USER / MONITOR_PASSWORD   HTTP basic auth for everything except /healthz (off when no password is set)

"Online" is the relay's open connections. Every open game tab holds one (a tab hidden for a minute lets go),
so it counts people with the game open. "Sessions" are new connections, reconnects included.
"""
import base64, hmac, json, os, sqlite3, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SITES = [tuple(s.strip() for s in p.split('=', 1)) for p in os.environ.get('SITES', '').split(',') if '=' in p]
POLL = max(5, int(os.environ.get('POLL_SECONDS', '15')))
RAW_DAYS = max(1, int(os.environ.get('RAW_DAYS', '14')))
DB = os.environ.get('DB', '/data/monitor.db')
PORT = int(os.environ.get('PORT', '8080'))
USER, PASSWORD = os.environ.get('MONITOR_USER', 'admin'), os.environ.get('MONITOR_PASSWORD', '')
PAGE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html'), 'rb').read()
TOTAL = '_total'                      # the sum over all sites, stored like a site

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, site TEXT NOT NULL, ok INTEGER, ms INTEGER, conn INTEGER, players INTEGER,
  sessions INTEGER, full INTEGER, uptime INTEGER, accepted INTEGER, rejected_full INTEGER);
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
CREATE TABLE IF NOT EXISTS hourly (site TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER, ok_n INTEGER, max_conn INTEGER, sum_conn INTEGER,
  max_players INTEGER, sessions INTEGER, full INTEGER, sum_ms INTEGER, PRIMARY KEY (site, hour));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""
UPSERT = """INSERT INTO hourly (site, hour, n, ok_n, max_conn, sum_conn, max_players, sessions, full, sum_ms) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (site, hour) DO UPDATE SET n = n + 1, ok_n = ok_n + excluded.ok_n, max_conn = max(max_conn, excluded.max_conn),
  sum_conn = sum_conn + excluded.sum_conn, max_players = max(max_players, excluded.max_players), sessions = sessions + excluded.sessions,
  full = full + excluded.full, sum_ms = sum_ms + excluded.sum_ms"""
# range -> (seconds back or None for everything, table, bucket seconds)
RANGES = {'6h': (6 * 3600, 'samples', 60), '24h': (86400, 'samples', 300), '7d': (7 * 86400, 'hourly', 3600),
          '30d': (30 * 86400, 'hourly', 3 * 3600), 'all': (None, 'hourly', 86400)}

last = {}                             # site -> (uptime, accepted, rejected_full) of its previous good sample
caps = {}                             # site -> the relay's connection cap


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.execute('PRAGMA busy_timeout = 15000')
    return c


def fetch(base):
    req = urllib.request.Request(base.rstrip('/') + '/mp/stats', headers={'User-Agent': 'bayline-monitor', 'Accept': 'application/json'})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=8) as r:
        d = json.loads(r.read(1 << 16))
    return d, int((time.monotonic() - t0) * 1000)


def sample(ts):
    rows = []
    for site, base in SITES:
        try:
            d, ms = fetch(base)
            t = d.get('totals') or {}
            up, acc, full = int(d.get('uptime_s', 0)), int(t.get('accepted', 0)), int(t.get('rejected_full', 0))
            caps[site] = int(d.get('max_connections', 0))
            pu, pa, pf = last.get(site, (None, None, None))
            if pu is None: new, turned = 0, 0                                  # first look: nothing to compare with
            elif up < pu or acc < pa: new, turned = acc, full                   # the relay restarted: its counters began again
            else: new, turned = acc - pa, max(0, full - pf)
            last[site] = (up, acc, full)
            rows.append((ts, site, 1, ms, int(d.get('connections', 0)), int(d.get('players', 0)), new, turned, up, acc, full))
        except Exception as e:                                                 # down, slow or not JSON: a gap in the chart
            print(f'{site}: {type(e).__name__}: {e}', flush=True)
            rows.append((ts, site, 0, None, None, None, 0, 0, None, None, None))
    ok = [r for r in rows if r[2]]
    rows.append((ts, TOTAL, 1 if ok else 0, None, sum(r[4] for r in ok) if ok else None, sum(r[5] for r in ok) if ok else None,
                 sum(r[6] for r in rows), sum(r[7] for r in rows), None, None, None))
    return rows


def record(con, rows):
    ts = rows[0][0]
    hour = ts - ts % 3600
    with con:
        con.executemany('INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rows)
        con.executemany(UPSERT, [(r[1], hour, r[2], r[4] or 0, r[4] or 0, r[5] or 0, r[6], r[7], r[3] or 0) for r in rows])
        total = rows[-1][4]
        if total is not None:
            peak = con.execute("SELECT v FROM meta WHERE k = 'peak'").fetchone()
            if not peak or total > json.loads(peak[0])['conn']:
                con.execute("INSERT OR REPLACE INTO meta VALUES ('peak', ?)", (json.dumps({'conn': total, 'ts': ts}),))


def poller():
    con = db()
    for site, _ in SITES:                  # carry the counters over a restart of the monitor itself
        r = con.execute('SELECT uptime, accepted, rejected_full FROM samples WHERE site = ? AND ok = 1 ORDER BY ts DESC LIMIT 1', (site,)).fetchone()
        if r: last[site] = r
    due, pruned = time.time(), 0
    while True:
        ts = int(time.time())
        try:
            record(con, sample(ts))
            if ts - pruned > 3600:
                with con: con.execute('DELETE FROM samples WHERE ts < ?', (ts - RAW_DAYS * 86400,))
                pruned = ts
        except Exception as e:
            print('poll failed:', type(e).__name__, e, flush=True)
        due += POLL
        if due < time.time(): due = time.time() + POLL                        # fell behind (slow sites): start afresh
        time.sleep(max(0.5, due - time.time()))


# ---------------------------------------------------------------- API
def api_now():
    con = db()
    ts = con.execute('SELECT MAX(ts) FROM samples').fetchone()[0]
    rows = con.execute('SELECT site, ok, ms, conn, players, uptime FROM samples WHERE ts = ?', (ts,)).fetchall() if ts else []
    by = {r[0]: r for r in rows}
    peak = con.execute("SELECT v FROM meta WHERE k = 'peak'").fetchone()
    since = con.execute('SELECT MIN(hour) FROM hourly').fetchone()[0]
    sites = [{'site': s, 'url': u, 'ok': bool(by[s][1]), 'ms': by[s][2], 'online': by[s][3], 'players': by[s][4], 'uptime': by[s][5],
              'cap': caps.get(s)} if s in by else {'site': s, 'url': u, 'ok': None} for s, u in SITES]
    t = by.get(TOTAL)
    return {'ts': ts, 'poll': POLL, 'since': since, 'online': t[3] if t else None, 'players': t[4] if t else None, 'sites': sites,
            'peak': json.loads(peak[0]) if peak else None}


def api_series(rng):
    back, table, step = RANGES[rng]
    now = int(time.time())
    since = now - back if back else 0
    if table == 'samples':
        q = (f'SELECT (ts / {step}) * {step} AS b, site, MAX(conn), MAX(players), SUM(sessions), AVG(ok) '
             'FROM samples WHERE ts >= ? GROUP BY b, site ORDER BY b')
    else:
        q = (f'SELECT (hour / {step}) * {step} AS b, site, MAX(max_conn), MAX(max_players), SUM(sessions), SUM(ok_n) * 1.0 / SUM(n) '
             'FROM hourly WHERE hour >= ? GROUP BY b, site ORDER BY b')
    out = {}
    for b, site, conn, players, sess, ok in db().execute(q, (since,)):
        out.setdefault(site, []).append([b, conn if ok else None, players if ok else None, sess, round(ok or 0, 3)])
    return {'range': rng, 'step': step, 'from': since, 'to': now, 'sites': [s for s, _ in SITES], 'series': out}


def api_daily(off_min):
    off = max(-900, min(900, off_min)) * 60          # the browser's UTC offset (minutes, as getTimezoneOffset gives it)
    q = ('SELECT (hour - ?) / 86400 AS d, site, MAX(max_conn), SUM(sessions), SUM(ok_n), SUM(n), SUM(full) '
         'FROM hourly WHERE hour >= ? GROUP BY d, site ORDER BY d DESC')
    days = {}
    for d, site, peak, sess, ok_n, n, full in db().execute(q, (off, int(time.time()) - 62 * 86400)):
        days.setdefault(d, {'day': d * 86400 + off, 'sites': {}})['sites'][site] = {'peak': peak, 'sessions': sess, 'up': ok_n / n if n else None, 'full': full}
    return {'days': [days[k] for k in sorted(days, reverse=True)]}


class Handler(BaseHTTPRequestHandler):
    server_version = 'bayline-monitor'

    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype, extra=()):
        self.send_response(code)
        for k, v in (('Content-Type', ctype), ('Content-Length', str(len(body))), ('Cache-Control', 'no-store'),
                     ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'), ('X-Frame-Options', 'DENY'), *extra):
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(body)

    def authed(self):
        if not PASSWORD: return True
        h = self.headers.get('Authorization', '')
        if not h.startswith('Basic '): return False
        try: user, _, pw = base64.b64decode(h[6:], validate=True).decode().partition(':')
        except Exception: return False
        return hmac.compare_digest(user.encode(), USER.encode()) & hmac.compare_digest(pw.encode(), PASSWORD.encode())

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/healthz': return self.reply(200, b'ok\n', 'text/plain')
        if not self.authed():
            return self.reply(401, b'Login required\n', 'text/plain', [('WWW-Authenticate', 'Basic realm="Bayline monitor", charset="UTF-8"')])
        try:
            if u.path == '/': return self.reply(200, PAGE, 'text/html; charset=utf-8')
            if u.path == '/api/now': data = api_now()
            elif u.path == '/api/series' and q.get('range', ['24h'])[0] in RANGES: data = api_series(q.get('range', ['24h'])[0])
            elif u.path == '/api/daily': data = api_daily(int(q.get('off', ['0'])[0]))
            else: return self.reply(404, b'Not found\n', 'text/plain')
        except ValueError:
            return self.reply(400, b'Bad request\n', 'text/plain')
        return self.reply(200, json.dumps(data, separators=(',', ':')).encode(), 'application/json')

    do_HEAD = do_GET


if __name__ == '__main__':
    if not SITES: raise SystemExit('set SITES, e.g. SITES="main=https://bayline.example.com"')
    os.makedirs(os.path.dirname(os.path.abspath(DB)), exist_ok=True)
    c = db(); c.execute('PRAGMA journal_mode = WAL'); c.executescript(SCHEMA); c.close()
    threading.Thread(target=poller, daemon=True).start()
    print(f'bayline-monitor on :{PORT}, polling {len(SITES)} site(s) every {POLL} s', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
