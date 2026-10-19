#!/usr/bin/env bash
# Runs the k6 load test against a production build of the server, with its own
# throwaway Redis (port 6390) so no real data is touched.
#
#   ./scripts/loadtest.sh                      # defaults: 25 offices, 500 residents, 3 min at peak
#   RESIDENTS=800 OFFICES=40 HOLD=5m ./scripts/loadtest.sh
#   BASE_URL=https://staging.example.org ./scripts/loadtest.sh   # an existing server (no local server started)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v k6 >/dev/null || { echo "k6 is not installed: https://grafana.com/docs/k6/latest/set-up/install-k6/"; exit 1; }

OUT=loadtest/results
mkdir -p "$OUT"
cleanup() { [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null; [[ -n "${REDIS_PID:-}" ]] && kill "$REDIS_PID" 2>/dev/null; wait 2>/dev/null || true; }
trap cleanup EXIT

if [[ -z "${BASE_URL:-}" ]]; then
  PORT=${LOADTEST_PORT:-3100}
  redis-server --port 6390 --save '' --appendonly no >/dev/null & REDIS_PID=$!
  [[ -f server/dist/index.js && -f web/dist/index.html ]] || npm run build >/dev/null
  # Every simulated phone comes from this machine's IP, so lift the per-IP limits.
  PORT=$PORT HOST=127.0.0.1 REDIS_URL=redis://127.0.0.1:6390 NODE_ENV=production LOG_LEVEL=info LOG_FORMAT=json \
    RATE_LIMIT_CREATE_OFFICE=1000/60 RATE_LIMIT_JOIN=1000000/60 RATE_LIMIT_NOTIFY=1000000/60 PUBLIC_URL=http://127.0.0.1:$PORT \
    VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= RESEND_API_KEY= SENTRY_DSN= \
    node server/dist/index.js >"$OUT/server.log" 2>&1 & SERVER_PID=$!
  BASE_URL=http://127.0.0.1:$PORT
  for _ in $(seq 50); do curl -sf "$BASE_URL/health" >/dev/null && break; sleep 0.2; done
  # Server CPU (% of one core) and memory every 5 s, for the report.
  (echo "time cpu% rss_mb"; while kill -0 "$SERVER_PID" 2>/dev/null; do ps -o %cpu=,rss= -p "$SERVER_PID" | awk -v t="$(date +%T)" '{printf "%s %s %.0f\n", t, $1, $2/1024}'; sleep 5; done) >"$OUT/server-stats.txt" &
fi

echo "Load testing $BASE_URL (offices=${OFFICES:-25}, residents=${RESIDENTS:-500}, hold=${HOLD:-3m})"
ulimit -n 10240 2>/dev/null || true
k6 run loadtest/queue.js -e BASE_URL="$BASE_URL" --summary-export "$OUT/summary.json" "$@"
