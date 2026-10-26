# Architecture

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

## Redis keys (per office, prefix `vq:o:<officeId>:`)

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
| `ev:<YYYY-MM-DD>` | list | ticket events for analytics: `{t, e, v, n, s, c?, k?, p?}` (time, event, visit hash, number, service, counter, kind, priority). Kept for `ANALYTICS_RETENTION_DAYS` while the office is active |

Global alert keys: `vq:alerts:jobs` and `vq:alerts:processing` (the job queue, claimed with leases) and `vq:alerts:reminders` (appointment reminders by due time).

All keys expire after `OFFICE_TTL_DAYS` of inactivity. Finished tickets (12 h), daily stats (8 days) and ticket sequences (2 days) have shorter TTLs. Rate-limit counters live at `vq:rl:<name>:<ip>`.

## Behavior notes

- **Estimated wait:** see [Wait estimates](priority-and-appointments.md#wait-estimates). It accounts for active counters and recent service times, and is shown as a range.
- **Leaving while being called:** the counter is freed immediately and the staff console shows "D-042 left the line before reaching the counter". Pressing Served afterwards gives a clear message, not an error page.
- **Empty queue / paused line:** Call Next is disabled with an explanation. If pressed anyway (e.g. from another window), the API returns a friendly 409 that the console displays.
- **Paused line:** residents can still join and keep their place, and they see a "briefly paused" notice. "Call next (any line)" skips paused lines.
- **No-show:** recorded in stats. The resident's screen tells them they were missed and offers to rejoin.
- **Stale screens:** Served and No-Show send the ticket number the staff member is looking at. If the counter has already moved on, the action is rejected rather than applied to the wrong person.
- **Sound:** browsers only allow audio after a tap. Tapping "Get my ticket" unlocks it. After a refresh, residents see a "Turn on sound alerts" button. The lobby display has a "Click to enable announcements" button that turns on a chime and a spoken call ("Ticket D 0 4 2, please go to Window A").
- **Staff keyboard shortcuts:** `N` call next · `S` served · `X` no-show · `R` recall.

## Project layout

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
  analytics.ts    dashboard calculations, CSV export, event history reads
  history.ts      simulated past days for demos
  cli.ts          create/seed offices from the terminal
  alerts/         service.ts (opt-in, scan, job queue & worker) · senders.ts (web push, Resend, log)
  setupAlerts.ts  generates VAPID keys into .env
  logger.ts       structured JSON logs, path redaction
  errors.ts       optional error tracking (Sentry), event scrubbing
  network.ts      LAN IP detection
web/public/       sw.js (push + notification clicks) · icons/
server/test/      vitest suite (real Redis, plus browser tests in Chrome)
loadtest/         k6 load test (queue.js); results/ is local output
deploy/           deploy guide for a shared server, example Caddyfile and production .env
.github/workflows/ci.yml  type-check, lint, test, build, and multi-arch Docker image on every push and PR
web/src/pages/    Home · Resident · Book · Appointment · Staff · StaffAppointments · Analytics · Display · Settings
web/src/components/Charts.tsx  small accessible SVG charts (each with a data table)
web/src/i18n/     en.ts (source text) · es.ts · index.tsx (language registry, provider, date/time formatting)
web/src/lib/      api client, socket hooks, clock sync, sound, text size
server/src/i18n.ts  languages the server accepts + alert texts in each
```

Environment variables are in [configuration.md](configuration.md).
