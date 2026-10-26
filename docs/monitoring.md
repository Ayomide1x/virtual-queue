# Monitoring

- **Structured logs:**
  - One JSON object per line in production (`time`, `level`, `msg`, `component`, …) and readable text in development. `LOG_FORMAT=json|pretty` and `LOG_LEVEL=debug|info|warn|error` override this.
  - Every API request is logged with method, path, status, duration, office and a **request id**. The id is also returned as `X-Request-Id`, and included in 500 responses so a report can be matched to its log line.
  - Secret ticket and appointment ids are replaced by `:id` and query strings are dropped. Email addresses are always masked, and staff keys are never logged.
- **`/health`** (also at `/api/health`):
  - `200 {"status":"ok","redis":{"ok":true,"latencyMs":1},"uptimeSec":…,"version":…}` when Redis answers within a second.
  - `503` with `redis_unavailable`, or with `shutting_down` during a graceful shutdown.
  - Docker's healthcheck uses it, and Caddy's `health_uri` can too.
- **Error tracking**, off unless **`SENTRY_DSN`** is set (Sentry, or any compatible service such as GlitchTip):
  - **What's reported:** unhandled request errors, failed broadcasts or subscriptions, uncaught exceptions and unhandled rejections.
  - **Browser crashes** are reported by the web app to `POST /api/client-errors`. That endpoint is rate-limited, and logs and forwards them. Pages also show a "Reload" screen instead of going blank.
  - **Privacy:** events carry no request bodies, headers, cookies, IP addresses or user data, and URLs are redacted.
- **Graceful shutdown** on `SIGTERM` or `SIGINT` (`docker stop`, deploys, Ctrl+C):
  1. `/health` switches to `shutting_down`.
  2. New connections are refused, and in-flight requests finish. Kept-alive connections are closed as they go idle.
  3. Sockets are disconnected (clients reconnect to the new instance), and alert sends under way are allowed to finish.
  4. Redis is closed, queued error reports are flushed, and the process exits 0.
  - Anything still running after `SHUTDOWN_TIMEOUT_MS` (10 s) is cut off. Compose allows 20 s.
