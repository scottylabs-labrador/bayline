#!/usr/bin/env python3
"""Bayline dev server: http://localhost:8123/

  /                  -> dist/index.html (the built game)
  /data/v2/<path>    -> data/pub/v2/<path> (streamed tiles and core data), with HTTP Range support
  anything else      -> the project root (preview pages, src, vendor ...)

Range requests (`Range: bytes=a-b`) are supported so Stream.range() behaves like nginx in production.
Usage: python3 tools/devserver.py [port]
"""
import os, sys, re, mimetypes, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# served trees: the checkout, plus whatever data/pub (or data/) links to (git worktrees share the main checkout's data)
ALLOWED = sorted({os.path.realpath(p) for p in (ROOT, os.path.join(ROOT, 'data'), os.path.join(ROOT, 'data', 'pub'))})
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
mimetypes.add_type('application/octet-stream', '.bin')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/json', '.json')


def resolve(path):
    path = path.split('?', 1)[0].split('#', 1)[0]
    if path in ('/', '/index.html'):
        return os.path.join(ROOT, 'dist', 'index.html')
    m = re.match(r'^/([a-z0-9_-]+)\.html$', path)       # /lead.html etc: private test builds in dist/ (BAYLINE_OUT)
    if m and os.path.isfile(os.path.join(ROOT, 'dist', m.group(1) + '.html')):
        return os.path.join(ROOT, 'dist', m.group(1) + '.html')
    if path.startswith('/data/v2/'):
        return os.path.join(ROOT, 'data', 'pub', 'v2', path[len('/data/v2/'):])
    return os.path.join(ROOT, path.lstrip('/'))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if os.environ.get('BAYLINE_DEVSERVER_LOG'):
            sys.stderr.write('%s\n' % (fmt % args))

    def do_HEAD(self):
        self.serve(head=True)

    def do_GET(self):
        self.serve(head=False)

    def serve(self, head):
        m = re.match(r'^/adsb/point/(-?[0-9]{1,2}\.[0-9])/(-?[0-9]{1,3}\.[0-9])/([0-9]{2,3})$', self.path)
        if m:   # the production nginx proxies adsb.lol (no CORS); do the same here for local testing
            import urllib.request
            try:
                req = urllib.request.Request('https://api.adsb.lol/v2/point/%s/%s/%s' % m.groups(), headers={'User-Agent': 'Bayline dev'})
                body = urllib.request.urlopen(req, timeout=8).read(); code = 200
            except Exception as e:
                body = b'{"ac":[]}'; code = 502
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers()
            if not head: self.wfile.write(body)
            return
        fp = os.path.realpath(resolve(self.path))
        if not any(fp.startswith(a + os.sep) for a in ALLOWED) or not os.path.isfile(fp):
            body = b'not found\n'
            self.send_response(404); self.send_header('Content-Type', 'text/plain'); self.send_header('Content-Length', str(len(body))); self.end_headers()
            if not head: self.wfile.write(body)
            return
        size = os.path.getsize(fp)
        ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        rng = self.headers.get('Range')
        start, end, status = 0, size - 1, 200
        if rng:
            m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
            if m:
                a, b = m.group(1), m.group(2)
                if a == '' and b != '': start, end = max(0, size - int(b)), size - 1
                else: start, end = int(a or 0), min(size - 1, int(b) if b else size - 1)
                if start > end or start >= size:
                    self.send_response(416); self.send_header('Content-Range', 'bytes */%d' % size); self.send_header('Content-Length', '0'); self.end_headers(); return
                status = 206
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'no-cache')
        if status == 206: self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        if head: return
        with open(fp, 'rb') as f:
            f.seek(start); left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk: break
                try: self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError): return
                left -= len(chunk)


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.daemon_threads = True
    print(f'Bayline dev server on http://localhost:{PORT}/  (root {ROOT})', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
