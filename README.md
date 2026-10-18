# Virtual Queue

A real-time, multi-office virtual queue for government offices (DMV, city services). Anyone can create an office in one click. Residents join from their phones and are alerted when it's their turn. Staff call people from a console, and a lobby TV shows who's being served. Each office is fully isolated and configurable.

| Screen | URL | Access |
| --- | --- | --- |
| Home | `/` | **Create an office** → staff, display and join links with copy buttons |
| Resident | `/o/:officeId/join` | Public: join, watch your place, get a "go to Window A" alert with sound |
| Lobby display | `/o/:officeId/display` | Public: Now Serving, recently called, QR code to this office's join page |
| Staff console | `/o/:officeId/staff` | **Staff key:** Call Next / Served / No-Show / Recall, pause lines, stats |
| Settings | `/o/:officeId/settings` | **Staff key:** name, services, counters, opening hours, time zone, appointments, demo data |
| Book | `/o/:officeId/book` | Public: book an appointment slot |
| Appointment | `/o/:officeId/appointment/:id` | Public (secret link): confirmation, check-in, cancel |
| Day view | `/o/:officeId/appointments` | **Staff key:** each day's appointments, check in or cancel on someone's behalf |

---

## Quick start (Docker, recommended for the demo)

```bash
./scripts/up.sh      # sets PUBLIC_URL to http://<your LAN IP>:3000 and your time zone, then docker compose up --build
```

Open <http://localhost:3000>, click **Create an office** (tick *Fill with sample residents* for a demo), and use the links it gives you. Or create one from the terminal:

```bash
docker compose exec app node server/dist/cli.js create --name "Riverside DMV" --seed
```

Plain `docker compose up --build` works too. Set `PUBLIC_URL` so QR codes and share links point at an address phones can reach:

```bash
PUBLIC_URL=http://$(ipconfig getifaddr en0):3000 docker compose up --build   # macOS
```

## Offices and staff keys

- Creating an office returns a random **office ID** and a secret **staff key**. Only a SHA-256 hash of the key is stored, so a lost key can't be recovered. Create a new office instead.
- The staff link looks like `/o/<id>/staff#key=<key>`. The key sits in the URL *fragment*, which browsers never send to the server or put in referrers. On first visit the page saves it to `localStorage` and removes it from the address bar. Staff can also paste the link or key into the "Staff access" form.
- Staff API calls send the key in the `X-Staff-Key` header. A missing key returns **401** and a wrong key, including another office's key, returns **403**. The staff Socket.IO subscription checks the key the same way. The display and join pages need no key.
- **Expiry:** an office and all its data expire after **30 days without activity** (`OFFICE_TTL_DAYS`). Every key an office writes gets a TTL in the same atomic step, and any request or socket subscription refreshes them. Unknown or expired offices show a clear "We couldn't find this office" page, and the API returns `404 office_not_found`.
- **Rate limits (per IP, stored in Redis):** creating offices is limited to 10 per hour (`RATE_LIMIT_CREATE_OFFICE=10/3600`) and joining a line to 30 per minute (`RATE_LIMIT_JOIN=30/60`). Over the limit the API returns 429 with `Retry-After`. Behind a reverse proxy, set `TRUST_PROXY` so the limits see real client IPs.

## Settings

Staff open **Settings** from the console. Changes apply to every open screen immediately.

- **Office:** name and **time zone**. Opening hours and "today" stats use the office's time zone, not the server's.
- **Services:** add, rename or remove services, and set each one's ticket letter (unique) and default service time, which is used for wait estimates until real data exists. Renaming keeps people in line. A service can't be removed while anyone is waiting in it or being served.
- **Counters:** add, rename or remove. Names like "Window A" appear on the display and in residents' alerts. A counter can't be removed while it's serving someone.
- **Opening hours:** per weekday, optional. Outside opening hours the join page shows "The line is closed — We open again Monday at 9:00 AM" and the display shows a banner. Staff can still serve people already in line. Pages update by themselves when the office opens or closes.
- **Demo data:** *Fill with sample residents* or *Clear all queues*.

New offices start with three services (Driver's License, Vehicle Registration, ID Card), four counters, and opening hours **switched off**, so a demo works at any time of day.

## Priority, appointments and wait estimates

### Queue order

Each line is one Redis sorted set, scored as

```
tier × 10¹⁵  +  orderAt × 100  +  seq mod 100        (tier 0 = priority, 1 = regular)
```

- **Priority tickets** come first, in their own **join order**, not the order staff marked them in. Staff give a waiting ticket priority from the star next to it in the console and pick a reason: disability, senior, returning no-show, or other. The reason is shown to staff only, never on public screens. Marking or unmarking is a Lua script that rescores the ticket atomically.
- **`orderAt`** is the join time for walk-ins and the **slot start** for checked-in appointments. An appointment therefore goes ahead of walk-ins who joined after its slot time and behind those who joined before it, whether the resident checks in early or late.
- `seq` breaks ties within the same millisecond, so ties stay first-come, first-served. Every score stays below 2⁵³, so Redis compares them exactly.
- Call Next is still a single `ZPOPMIN` on the lowest score, so mixed priority, appointment and walk-in traffic stays atomic. "Any line" takes the lowest score across lines, so priority tickets anywhere go first.

### Appointments

- **Slots** come from the weekly hours table, in the office's time zone and correct across daylight-saving changes. They use the configured **slot length**, with a **capacity per slot per service** and a **booking horizon** in days. Slots come from the hours table even when "only allow joining during opening hours" is off.
- **Booking** is a Lua script that checks and increments the slot's count, so simultaneous bookings can never overfill a slot. The resident gets a **confirmation link** with a secret ID and a short reference code like `KHAVW7`, and can **cancel**, which frees the place.
- **Check-in** happens from the confirmation link, or by staff from the day view. It is allowed from *early* minutes before to *late* minutes after the slot (15 and 10 by default):
  - too early: refused, with "Check-in opens at 9:45 AM"
  - within the window: becomes a ticket with `orderAt` = slot start
  - after the window: the appointment is **missed**
  - checking in twice returns the same ticket
- **Missed appointments** are persisted at check-in time, by a 30-second sweep, and when staff open the day view. Appointment data expires two days after its slot.
- A service can't be removed while it has upcoming bookings.

### Wait estimates

- **Service time** is the mean and quartiles of recent service durations. Each duration is stored with its end time; durations from the last 3 hours are used when there are at least 3, otherwise the last 20 recorded, otherwise the service's default.
- **Active counters** come from each counter's calls in the last 30 minutes, split across the lines it called from. A counter alternating between two lines counts as 0.5 for each. A counter still busy with someone called earlier counts fully for that line.
- **Estimate** = people ahead × mean ÷ counters, shown as a **range** from the 25th to 75th percentile service times ("8–12 min"). With fewer than 3 samples the range is −25 % / +30 % around the mean.

## Alerts: web push, with email as a fallback

Residents can turn on alerts after joining, or after booking an appointment. They get:

- **"Almost your turn"** when 3 or fewer people are ahead. It isn't sent if they were already that close when they opted in.
- **"It's your turn: go to Window A"** when called.
- **A reminder 1 hour before an appointment.** It isn't sent if they booked less than an hour ahead. After check-in, the same contact details also get the two alerts above.
- A one-time **"Alerts are on"** confirmation per channel, so residents know it works.

### Setup

```bash
npm run setup:alerts        # creates VAPID keys in .env (keeps existing ones; --force to rotate)
```

Then edit `.env`:

- `VAPID_SUBJECT`: a `mailto:` address you read. Push services use it to contact you.
- `RESEND_API_KEY` and `EMAIL_FROM`: optional, for real email through Resend's free tier. **Without a key, emails are written to the server log instead**, with the address masked.

Restart the server, or run `docker compose up -d --build`. Compose reads `.env`. The server prints which channels are active at startup.

**Web push needs HTTPS.** Browsers only allow it on `https://` or `localhost`. Over plain `http://192.168.x.x`, phones are offered email instead. For a demo, a free tunnel works:

```bash
brew install cloudflared                                  # or see Cloudflare's docs for Linux/Windows
cloudflared tunnel --url http://localhost:3000           # prints https://<random>.trycloudflare.com
```

Then put these in `.env` and restart (`docker compose up -d app`, or `./scripts/up.sh`, which respects a `PUBLIC_URL` in `.env`):

```bash
PUBLIC_URL=https://<random>.trycloudflare.com   # QR codes and links use it
TRUST_PROXY=1                                   # all tunnel traffic arrives from one address; this makes rate limits per phone
```

Things learned testing on real phones:

- **A quick tunnel's URL changes every time `cloudflared` restarts.** Update `PUBLIC_URL` and restart the app. Links, QR codes, Home Screen apps and push subscriptions are tied to the old address, so residents need to re-open the new join link (and re-add it to the Home Screen on iPhone). For a stable address, use a named Cloudflare tunnel on your own domain.
- **Resend's test sender (`onboarding@resend.dev`) only delivers to the email on your Resend account.** Other recipients are rejected (permanent error, not retried). To email residents, verify a domain in Resend and set `EMAIL_FROM` to an address on it.
- **A "sending access" Resend key can't read delivery status**, so check your inbox (and spam) to confirm a test email arrived.

**iPhone/iPad** (iOS 16.4+) only allow web push for sites added to the Home Screen. The join page is an installable PWA, with a per-office manifest, a service worker and icons. iPhone users who haven't installed it see a 3-step visual guide: Share → Add to Home Screen → open the app and tap Notify me. iOS gives home-screen apps their own storage, so the saved URL must carry the resident's ticket. **iOS reads the manifest once, when the page loads (before the resident joins), and doesn't re-read it when the page updates it.** So the join page keeps `?ticket=…` in the address bar, and the manifest leaves out `start_url` until there's a ticket, which makes iOS save the address bar URL. The installed app then opens straight to the resident's place in line. A ticket already stored in the app wins over the one in its start URL, since that URL never changes.

### How it works

```
queue mutation ──► PUBLISH office event ──► scan (debounced)  ──ENQUEUE_ALERT (Lua)──►  vq:alerts:jobs (sorted set by run time)
     (never waits on alerts)                "≤3 ahead?" "called?"   HSETNX dedupe              │
                                                                                     worker: CLAIM_JOBS (Lua, with lease)
                                                                                       ├─ push  → web-push (VAPID) → FCM / Mozilla / Apple
                                                                                       └─ email → Resend API (or log)
```

- **Never blocks the queue.** Queue operations only publish an event, which they already did. Scanning, sending and retrying all happen in the background worker. Each send has a 15 s timeout, so a hung push service only delays that one alert.
- **No duplicates.** Each alert is claimed once per ticket by `HSETNX` on its "alerted" hash, inside the same Lua script that queues the jobs. Repeated scans, or several server processes, can't queue it twice. Jobs are claimed atomically, and reminders are claimed by whichever process removes them from the reminder set.
- **Retries.** Failed sends (timeout, 429, 5xx, network) retry with exponential backoff and jitter: 5 s, 10 s, 20 s and so on, capped at 5 min, up to 6 attempts. Permanent rejections aren't retried. A worker that crashes mid-send loses its lease after 60 s, and the job runs again.
- **Expired subscriptions** (push service answers 404/410) are deleted automatically and not retried. Email keeps working.
- **Stale alerts are dropped.** A "3 away" that comes due after the resident was already called isn't sent. Neither is a reminder for a cancelled appointment.
- **Privacy.**
  - Contact details are deleted in the **same atomic step** that ends the ticket (served, no-show or left). Cancelled and missed appointments lose theirs too. Queued alerts for ended tickets are dropped.
  - Everything also expires with the office.
  - The API only ever returns masked addresses (`a******@g****.com`), and **logs never contain a full address**.
  - Push endpoints must belong to a known push service (Google, Mozilla, Microsoft, Apple), so the server never sends requests to arbitrary URLs.

## Local development

Requires Node 20+ and Redis 6.2+ (`brew install redis && brew services start redis`, or `docker run -p 6379:6379 redis:7-alpine`).

```bash
npm install
npm run dev       # API on :3000, Vite dev server on :5173 (both bind 0.0.0.0)
```

Open <http://localhost:5173> and create an office (or `npm run office -- create --seed`). Without `PUBLIC_URL`, links and QR codes use your detected LAN IP with the current port, so phones on the same Wi-Fi can use the dev server.

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

**136 tests in nine files**, including:

- `alerts.test.ts`, with fake push and email senders:
  - "3 away" sent once, including when people leave and the line jumps
  - no instant alert when opting in close to the front
  - "your turn" with the counter name, sent once despite recalls
  - stale alerts dropped
  - two server processes never sending a duplicate
  - exponential backoff timing, giving up after the maximum attempts, permanent rejections not retried
  - expired subscriptions removed
  - a hung push service timing out without slowing the queue
  - crash recovery after a lease runs out
  - contact details deleted when a ticket ends in each of the three ways
  - full addresses never logged
  - appointment reminders, including under an hour ahead, cancelled, missed, and contact details moving to the ticket at check-in
  - an end-to-end run through the HTTP API and pub/sub
- `senders.test.ts`: `ResendEmailSender` request shape and status handling, and `WebPushSender` against a local HTTPS push endpoint (encrypted `aes128gcm` body, VAPID `Authorization` header, 404/410 → expired, 503 → retry, 400 → permanent).

Also:

- `priority.test.ts`: priority ordering (own join order, unmarking, line isolation, beating appointments), and **concurrent Call Next with mixed priority, appointment and walk-in tickets**. 8 counters × 3 rounds fire at once and every ticket is assigned exactly once, in the exact expected order, checked against the order Redis actually called them in.
- `appointments.test.ts`: slot generation including a DST change, capacity under 10 simultaneous bookings, check-in window edges, too-early and missed, early or late check-in ranking, idempotent and simultaneous check-ins, cancel, the day view, and blocking service removal.
- `estimates.test.ts`: percentile ranges, counter-weighted estimates, shared counters, the rolling time window and its fallback.

From the earlier work:

- `queueStore.test.ts` covers queue logic and concurrency.
- `offices.test.ts` covers office creation, key hashing, isolation, settings rules, and TTL/expiry, including an office actually expiring.
- `officeConfig.test.ts` covers opening hours across time zones and settings validation.
- `api.test.ts` covers HTTP and Socket.IO end to end: 401/403 on every staff route, other offices' keys rejected, tickets and live updates confined to their office, staff sockets refused with wrong keys, settings, closed hours, and rate limits.

The queue tests cover ordering, the rolling-average wait estimate, pause/resume, served/no-show/recall, leaving (including leaving *while being called*), calling an empty queue, stale-screen double clicks, privacy of the public payloads, the seed, and the concurrency cases:

- two staff pressing **Call Next** at the same instant on one remaining ticket → exactly one gets it
- 18 simultaneous calls from 6 counters on 4 tickets → 4 distinct assignments, none duplicated
- double-clicking Call Next on one counter → only one resident called
- a resident leaving at the same moment they're called → the state stays consistent

---

## Architecture

```
┌──────────── Browser (React + Vite + Tailwind) ────────────┐
│  /o/:id/join      /o/:id/staff      /o/:id/display  …     │
│        │ REST actions (fetch)    ▲ live state (Socket.IO) │
└────────┼─────────────────────────┼────────────────────────┘
         ▼                         │
┌──────────── Node server (Express + Socket.IO) ────────────┐
│ /api/o/:id/* ─► office lookup (404) ─► staff key (401/403)│
│   ─► QueueStore(office config) ─(one Lua script)──►       │
│                 │ PUBLISH vq:o:<id>:events                │
│ PSUBSCRIBE ◄────┘  → per-office debounced broadcast:      │
│   <id>:staff (full) · <id>:lobby (numbers only)           │
│   <id>:ticket:<uuid> (each resident's own position)       │
└──────────────────────────────┬────────────────────────────┘
                               ▼
                 Redis (AOF persistence, Docker volume)
```

- **All queue state lives in Redis**, and the Node process is stateless. Restarting the server (or Redis, thanks to AOF) doesn't lose the queue.
- **Every mutation is a single Lua script** (`server/src/scripts.ts`): join, call next, complete (served / no-show), leave, and recall. Redis runs one script at a time, so there is never a window where two operations see the same intermediate state.
- **Call Next** checks the counter isn't busy, finds the longest-waiting head among unpaused lines, `ZPOPMIN`s it, and assigns it to the counter, all in one atomic step. A ticket can't be assigned to two counters.
- **Offices are isolated by key prefix and room name.** Every key lives under `vq:o:<officeId>:`, and office IDs are validated (`[a-z0-9]`) before use. A ticket ID only resolves inside its own office's prefix. Socket rooms and pub/sub channels are named per office.
- **Sync:** after each mutation the store `PUBLISH`es on its office's channel. Every server process (and the CLI) goes through this, so that office's screens refresh. A 30-second tick also pushes changes when an office opens or closes. Clients send `subscribe` again on every reconnect, and the server replies with current state straight away, so a dropped connection catches up on its own.
- **Privacy:** tickets are identified by unguessable UUIDs that only the resident's device knows (stored in `localStorage`). Staff and lobby payloads carry only public ticket numbers, and the lobby carries no names.

### Redis keys (per office, prefix `vq:o:<officeId>:`)

| Key | Type | Purpose |
| --- | --- | --- |
| `meta` | hash | office settings (JSON), SHA-256 of the staff key, createdAt |
| `ticket:<uuid>` | hash | number, name, service, status, timestamps, counter, recallCount |
| `queue:<service>` | sorted set | waiting ticket ids, scored by join time (with a sequence tiebreak for strict FIFO) |
| `counters` | hash | counter → ticket currently being served |
| `counterlast` | hash | counter → last outcome (served / no-show / left), shown to staff |
| `paused` | set | paused services |
| `svctimes:<service>` | list | last 20 service durations, used for the rolling average |
| `stats:<YYYY-MM-DD>` | hash | per-service served / no-show / left counts and wait-time sums for "today" |
| `seq:<YYYY-MM-DD>:<service>` | counter | daily ticket numbers (D-001, D-002 …) |
| `recent` | list | recently called/recalled tickets for the lobby |
| `calllog` | list | last 200 calls (counter, service, time), used to count active counters |
| `appt:<uuid>` | hash | appointment: ref, name, service, date, time, slotStart, status, ticketId |
| `appts:<date>` | sorted set | appointments on a date, by slot start (day view, missed sweep) |
| `notify:<ticketId>` / `notify:appt:<id>` | hash | alert contact: `push` (subscription JSON) and/or `email`. Deleted when the ticket or appointment ends |
| `notifyidx` | set | tickets with alerts on, used by the scan |
| `alerts:<ticketId>` / `alerts:appt:<id>` | hash | alerts already queued, for dedupe. No personal data |
| `slots:<date>` | hash | `HH:MM\|service` → bookings in that slot (capacity check) |

Global alert keys: `vq:alerts:jobs` and `vq:alerts:processing` (the job queue, claimed with leases) and `vq:alerts:reminders` (appointment reminders by due time).

All keys expire after `OFFICE_TTL_DAYS` of inactivity. Finished tickets (12 h), daily stats (8 days) and ticket sequences (2 days) have shorter TTLs. Rate-limit counters live at `vq:rl:<name>:<ip>`.

### Behavior notes

- **Estimated wait:** see *Wait estimates* above. It accounts for active counters and recent service times, and is shown as a range.
- **Leaving while being called:** the counter is freed immediately and the staff console shows "D-042 left the line before reaching the counter". Pressing Served afterwards gives a clear message, not an error page.
- **Empty queue / paused line:** Call Next is disabled with an explanation. If pressed anyway (e.g. from another window), the API returns a friendly 409 that the console displays.
- **Paused line:** residents can still join and keep their place, and they see a "briefly paused" notice. "Call next (any line)" skips paused lines.
- **No-show:** recorded in stats. The resident's screen tells them they were missed and offers to rejoin.
- **Stale screens:** Served and No-Show send the ticket number the staff member is looking at. If the counter has already moved on, the action is rejected rather than applied to the wrong person.
- **Sound:** browsers only allow audio after a tap. Tapping "Get my ticket" unlocks it. After a refresh, residents see a "Turn on sound alerts" button. The lobby display has a "Click to enable announcements" button that turns on a chime and a spoken call ("Ticket D 0 4 2, please go to Window A").
- **Staff keyboard shortcuts:** `N` call next · `S` served · `X` no-show · `R` recall.

### Configuration (environment variables)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `REDIS_URL` | `redis://127.0.0.1:6379` | |
| `PUBLIC_URL` | `http://$HOST_IP:$PORT` if `HOST_IP` is set | Base URL for QR codes and share links. `up.sh` sets it to your LAN address |
| `HOST_IP` | auto-detected (not in Docker) | LAN IP, used when `PUBLIC_URL` isn't set |
| `OFFICE_TTL_DAYS` | `30` | Inactivity expiry for offices |
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

### Project layout

```
server/src/
  queueStore.ts   queue logic, priority & wait estimates for one office (the core)
  appointments.ts booking, check-in, missed sweep, staff day view
  offices.ts      office registry: create, staff keys, settings, TTL refresh
  officeConfig.ts settings schema, defaults, time zones, opening hours
  scripts.ts      atomic Lua scripts
  rateLimit.ts    per-IP limits in Redis
  app.ts          REST API + Socket.IO rooms + broadcast
  seed.ts         sample residents for any office
  cli.ts          create/seed offices from the terminal
  alerts/         service.ts (opt-in, scan, job queue & worker) · senders.ts (web push, Resend, log)
  setupAlerts.ts  generates VAPID keys into .env
web/public/       sw.js (push + notification clicks) · icons/
  network.ts      LAN IP detection
server/test/      vitest suite (real Redis)
web/src/pages/    Home · Resident · Book · Appointment · Staff · StaffAppointments · Display · Settings
web/src/lib/      api client, socket hooks, clock sync, sound
```

### Demo-scope limitations

- Staff access is a single shared key per office, with no individual accounts, no audit log and no key rotation. If the staff link leaks, create a new office.
- Opening hours are one window per day, with no overnight hours or holidays. Appointment slots follow the same limits.
- Alerts use free channels only, push and email. There is no SMS.
- Web push needs HTTPS, so on a plain-http LAN demo phones get email instead. iPhones also need the site added to the Home Screen.
- Waiting tickets created by the earlier version use the old scoring. Reseed or clear existing offices after upgrading.
- Upgrading from the single-office version leaves its old `vq:*` keys in Redis unused. Run `docker compose down -v` for a clean slate.
