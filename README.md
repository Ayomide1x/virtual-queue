# Virtual Queue — City Services Office

A real-time virtual queue for a government office (DMV / city services). Residents join from their phone and are alerted when it's their turn. Staff call people from a console, and a lobby TV shows who's being served.

| Screen | URL | For |
| --- | --- | --- |
| Resident | `/join` | Phones: join, watch your place, get a "go to Counter 2" alert with sound |
| Staff console | `/staff` | Desktop: Call Next / Served / No-Show / Recall, pause lines, stats |
| Lobby display | `/display` | TV: Now Serving, recently called, QR code to join |

All three screens stay in sync in real time across any number of windows and devices.

---

## Quick start (Docker, recommended for the demo)

Requires Docker Desktop.

```bash
./scripts/up.sh          # detects your LAN IP + time zone, then: docker compose up --build
```

Plain `docker compose up --build` also works, but the container can't detect your LAN IP on its own. If you start it that way, pass the IP yourself:

```bash
HOST_IP=$(ipconfig getifaddr en0) docker compose up --build     # macOS
HOST_IP=$(hostname -I | awk '{print $1}') docker compose up --build   # Linux
```

Then open:

- Staff: <http://localhost:3000/staff>
- Lobby display: <http://localhost:3000/display>, full-screen it on the TV or projector
- Resident: scan the QR code on the display with a phone on the **same Wi-Fi**, or open `http://<your-LAN-IP>:3000/join`

On first start the queue is **pre-filled with sample residents** (`SEED_ON_START=if-empty`). Restarts keep whatever state is in Redis.

Stop with `Ctrl+C` or `docker compose down`. Add `-v` to also wipe the Redis volume.

## Seeding sample data

The seed simulates a morning at the office: about 16 residents already served (so stats and average service times look realistic), 2 no-shows, 15 people waiting across the three lines, and 2 counters mid-service. It **replaces** the current queue state.

| How | Command |
| --- | --- |
| Staff console | **Demo tools → Load sample residents** (bottom of the page) |
| Docker | `docker compose exec app node server/dist/seed.js` |
| Local dev | `npm run seed` |
| API | `curl -X POST http://localhost:3000/api/admin/seed` |

All open screens update the moment seeding finishes. **Demo tools → Clear all queues** starts from an empty office.

## Local development

Requires Node 20+ and Redis 6.2+ (`brew install redis && brew services start redis`, or `docker run -p 6379:6379 redis:7-alpine`).

```bash
npm install
npm run seed      # optional: populate the queue
npm run dev       # API on :3000, Vite dev server on :5173 (both bind 0.0.0.0)
```

Open <http://localhost:5173>. Phones can use `http://<your-LAN-IP>:5173/join`, and the QR code on the display points there automatically.

For a production-style run without Docker: `npm run build && npm start` (serves everything on :3000).

## Tests

```bash
npm test
```

The tests run against a **real Redis**, so the Lua scripts and their atomicity are actually exercised. The test setup starts a throwaway, non-persistent `redis-server` on port 6399, so your own Redis data is never touched. If `redis-server` isn't installed, point the tests at any Redis:

```bash
docker run --rm -d -p 6399:6379 redis:7-alpine
TEST_REDIS_URL=redis://127.0.0.1:6399 npm test
```

The suite covers ordering, the rolling-average wait estimate, pause/resume, served/no-show/recall, leaving (including leaving *while being called*), calling an empty queue, stale-screen double clicks, privacy of the public payloads, the seed, and the concurrency cases:

- two staff pressing **Call Next** at the same instant on one remaining ticket → exactly one gets it
- 18 simultaneous calls from 6 counters on 4 tickets → 4 distinct assignments, none duplicated
- double-clicking Call Next on one counter → only one resident called
- a resident leaving at the same moment they're called → the state stays consistent

---

## Architecture

```
┌──────────── Browser (React + Vite + Tailwind) ────────────┐
│  /join (resident)     /staff (console)     /display (TV)  │
│        │ REST actions (fetch)    ▲ live state (Socket.IO) │
└────────┼─────────────────────────┼────────────────────────┘
         ▼                         │
┌──────────── Node server (Express + Socket.IO) ────────────┐
│ routes ──► QueueStore ──(one Lua script per mutation)──►  │
│                 │ PUBLISH vq:events                       │
│ subscriber ◄────┘  → debounced broadcast:                 │
│     staff room: full state · lobby room: numbers only     │
│     ticket:<id> rooms: each resident's own position       │
└──────────────────────────────┬────────────────────────────┘
                               ▼
                 Redis (AOF persistence, Docker volume)
```

- **All queue state lives in Redis**, and the Node process is stateless. Restarting the server (or Redis, thanks to AOF) doesn't lose the queue.
- **Every mutation is a single Lua script** (`server/src/scripts.ts`): join, call next, complete (served / no-show), leave, and recall. Redis runs one script at a time, so there is never a window where two operations see the same intermediate state.
- **Call Next** checks the counter isn't busy, finds the longest-waiting head among unpaused lines, `ZPOPMIN`s it, and assigns it to the counter, all in one atomic step. A ticket can't be assigned to two counters.
- **Sync:** after each mutation the store `PUBLISH`es on `vq:events`. Every server process (and the standalone seed script) goes through this, so all screens refresh. Clients send `subscribe` again on every reconnect, and the server replies with current state straight away, so a dropped connection catches up on its own.
- **Privacy:** tickets are identified by unguessable UUIDs that only the resident's device knows (stored in `localStorage`). Staff and lobby payloads carry only public ticket numbers, and the lobby carries no names.

### Redis keys (prefix `vq:`)

| Key | Type | Purpose |
| --- | --- | --- |
| `ticket:<uuid>` | hash | number, name, service, status, timestamps, counter, recallCount |
| `queue:<service>` | sorted set | waiting ticket ids, scored by join time (with a sequence tiebreak for strict FIFO) |
| `counters` | hash | counter → ticket currently being served |
| `counterlast` | hash | counter → last outcome (served / no-show / left), shown to staff |
| `paused` | set | paused services |
| `svctimes:<service>` | list | last 20 service durations, used for the rolling average |
| `stats:<YYYY-MM-DD>` | hash | per-service served / no-show / left counts and wait-time sums for "today" |
| `seq:<YYYY-MM-DD>:<service>` | counter | daily ticket numbers (D-001, D-002 …) |
| `recent` | list | recently called/recalled tickets for the lobby |

### Behavior notes

- **Estimated wait** = people ahead × rolling average service time for that service (mean of the last 20 Called→Served durations, with a sensible per-service default until history exists).
- **Leaving while being called:** the counter is freed immediately and the staff console shows "D-042 left the line before reaching the counter". Pressing Served afterwards gives a clear message, not an error page.
- **Empty queue / paused line:** Call Next is disabled with an explanation. If pressed anyway (e.g. from another window), the API returns a friendly 409 that the console displays.
- **Paused line:** residents can still join and keep their place, and they see a "briefly paused" notice. "Call next (any line)" skips paused lines.
- **No-show:** recorded in stats. The resident's screen tells them they were missed and offers to rejoin.
- **Stale screens:** Served and No-Show send the ticket number the staff member is looking at. If the counter has already moved on, the action is rejected rather than applied to the wrong person.
- **Sound:** browsers only allow audio after a tap. Tapping "Get my ticket" unlocks it. After a refresh, residents see a "Turn on sound alerts" button. The lobby display has a "Click to enable announcements" button that turns on a chime and a spoken call ("Ticket D 0 4 2, please go to counter 2").
- **Staff keyboard shortcuts:** `N` call next · `S` served · `X` no-show · `R` recall.

### Configuration (environment variables)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `REDIS_URL` | `redis://127.0.0.1:6379` | |
| `HOST_IP` | auto-detected (not in Docker) | LAN IP for the lobby QR code |
| `PUBLIC_JOIN_URL` | — | Override the QR code URL entirely |
| `COUNTERS` | `6` | |
| `SEED_ON_START` | `never` (`if-empty` in Docker) | `always` / `if-empty` / `never` |
| `TZ` | system / `UTC` in Docker | Decides when "today" stats roll over. `up.sh` passes your local zone |

You can also add `?joinUrl=…` to the display URL to override the QR target on the spot.

### Project layout

```
server/src/
  queueStore.ts   queue logic & queries (the core)
  scripts.ts      atomic Lua scripts
  app.ts          REST API + Socket.IO rooms + broadcast
  seed.ts         demo data
  network.ts      LAN IP detection
server/test/      vitest suite (real Redis)
web/src/pages/    Resident.tsx · Staff.tsx · Display.tsx · Home.tsx
web/src/lib/      api client, socket hooks, clock sync, sound
```

### Demo-scope limitations

There is no staff login: anyone who can reach `/staff` can operate it. Put it behind your SSO or a VPN before real-world use.
