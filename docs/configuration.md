# Configuration (environment variables)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `REDIS_URL` | `redis://127.0.0.1:6379` | |
| `PUBLIC_URL` | `http://$HOST_IP:$PORT` if `HOST_IP` is set | Base URL for QR codes and share links. `up.sh` sets it to your LAN address |
| `HOST_IP` | auto-detected (not in Docker) | LAN IP, used when `PUBLIC_URL` isn't set |
| `OFFICE_TTL_DAYS` | `30` | Inactivity expiry for offices |
| `BIND_IP` | `0.0.0.0` | Compose only: host address the app's port is published on. Use `127.0.0.1` behind a reverse proxy |
| `NODE_ENV` / `APP_ENV` | `production` in Docker | `APP_ENV` (or `NODE_ENV`) is the environment name in logs and error reports |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` in production, else `pretty` | |
| `SENTRY_DSN` | unset | Turns on error tracking (Sentry or a compatible service) |
| `APP_VERSION` | `package.json` version | Shown by `/health` and attached to error reports. CI and deploys pass the git SHA |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown time limit |
| `ANALYTICS_RETENTION_DAYS` | `90` | Days of ticket history (analytics) an active office keeps |
| `RATE_LIMIT_CREATE_OFFICE` | `10/3600` | Office creations per IP per window (requests/seconds) |
| `RATE_LIMIT_JOIN` | `30/60` | Joins per IP per window |
| `RATE_LIMIT_BOOK` | `10/600` | Appointment bookings per IP per window |
| `RATE_LIMIT_NOTIFY` | `20/600` | Alert opt-ins per IP per window |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | unset | Web push keys. `npm run setup:alerts` generates them. Without them, push is off |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact address for push services |
| `RESEND_API_KEY` | unset | Enables real email through Resend. Unset means emails are only logged, with addresses masked |
| `EMAIL_FROM` | `Virtual Queue <onboarding@resend.dev>` | Sender. Must be on a domain verified in Resend |
| `TRUST_PROXY` | unset | Express `trust proxy` (e.g. `1`) when behind a reverse proxy |
| `TZ` | system / `UTC` in Docker | Only affects server logs. Each office has its own time zone |
