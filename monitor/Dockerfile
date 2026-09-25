# Bayline monitor: polls the deployments' multiplayer relays and serves the history (see monitor.py).
# Build context: this directory. Keep /data on a persistent volume.
FROM python:3.12-alpine
WORKDIR /app
COPY monitor.py index.html ./
RUN adduser -S -D -H -s /sbin/nologin monitor && mkdir -p /data && chown monitor /data
USER monitor
ENV PORT=8080 DB=/data/monitor.db PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["python3", "/app/monitor.py"]
