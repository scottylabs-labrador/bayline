# Bayline: one small image = the single-file game served by nginx + the multiplayer relay
# (Python, 127.0.0.1:8765, proxied at /ws and /mp/stats). Build context: the repository root.
# Keep data/raw out of the build context (see .dockerignore).

FROM python:3.12-alpine AS build
WORKDIR /src
COPY . .
RUN python3 build.py                     # writes dist/index.html (stdlib-only build script; data is streamed, not embedded)

FROM python:3.12-alpine
RUN apk add --no-cache nginx \
 && pip install --no-cache-dir websockets==16.0 \
 && adduser -S -D -H -s /sbin/nologin mp \
 && mkdir -p /usr/share/nginx/html
COPY server/nginx.conf /etc/nginx/nginx.conf
COPY server/mp.py /app/mp.py
COPY server/entrypoint.sh /entrypoint.sh
COPY --from=build /src/dist/index.html /usr/share/nginx/html/index.html
RUN chmod +x /entrypoint.sh && gzip -9 -k /usr/share/nginx/html/index.html && nginx -t
ENV MP_MAX_CONN=150 MP_MAX_PER_IP=3 MP_TICK_HZ=1
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
ENTRYPOINT ["/entrypoint.sh"]
