# Development

## Running with Docker

```bash
./scripts/up.sh      # sets PUBLIC_URL to http://<your LAN IP>:3000 and your time zone, then docker compose up --build
```

Open <http://localhost:3000>, click **Create an office** (tick *Fill with sample residents* to start with people in line), and use the links it gives you. Or create one from the terminal:

```bash
docker compose exec app node server/dist/cli.js create --name "Riverside DMV" --seed
```

Plain `docker compose up --build` works too. Set `PUBLIC_URL` so QR codes and share links point at an address phones can reach:

```bash
PUBLIC_URL=http://$(ipconfig getifaddr en0):3000 docker compose up --build   # macOS
```

## Deploying to a server

For a real deployment, see **[deploy/README.md](../deploy/README.md)**. It covers an Oracle Cloud ARM Ubuntu instance shared with another Docker Compose app:
- the app listens only on `127.0.0.1:3210`, and Redis stays unexposed
- one shared Caddy serves both apps on their own domains with automatic HTTPS (example Caddyfile included)
- `PUBLIC_URL`, `TRUST_PROXY`, and opening ports 80 and 443 in both the Oracle security list and the server firewall

## Local development

Requires Node 20+ and Redis 6.2+ (`brew install redis && brew services start redis`, or `docker run -p 6379:6379 redis:7-alpine`).

```bash
npm install
npm run dev       # API on :3000, Vite dev server on :5173 (both bind 0.0.0.0)
```

Open <http://localhost:5173> and create an office (or `npm run office -- create --seed`). Without `PUBLIC_URL`, links and QR codes use your detected LAN IP with the current port, so phones on the same Wi-Fi can use the dev server.

For a production-style run without Docker: `npm run build && npm start` (serves everything on :3000).

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push and pull request:

1. **Checks:**
   - `npm ci`, then `npm run typecheck`, `npm run lint` (ESLint with TypeScript and React-hooks rules, zero warnings allowed) and `npm test`
   - the tests run against a Redis service container, including the browser tests in the runner's Chrome
   - then `npm run build`
2. **Docker:**
   - builds the image for **linux/amd64 and linux/arm64** (the production server is ARM), with layer caching
   - then smoke-tests it: starts it next to Redis, checks `/health` reports `ok`, and checks `docker stop` produces a clean `shutdown complete`

Run the same checks locally with `npm run typecheck && npm run lint && npm test && npm run build`.
