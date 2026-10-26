# Virtual Queue

A real-time virtual queue for government offices such as a DMV or city services. Residents scan a QR code, join from their phone, and get an alert when it's their turn. Staff call people from a console, and a lobby TV shows who's being served. Anyone can create an office in one click, and each office is isolated and configurable.

**Live demo: <https://queue.ayomideo.dev>.** Click **Create an office** and tick *Fill with sample residents*.

| Screen | URL | Access |
| --- | --- | --- |
| Home | `/` | **Create an office** → staff, display and join links with copy buttons |
| Resident | `/o/:officeId/join` | Public: join, watch your place, get a "go to Window A" alert with sound |
| Ticket | `/o/:officeId/t/:ticketId` | Public (secret link): your place in line; the iPhone Home Screen app opens here |
| Lobby display | `/o/:officeId/display` | Public: Now Serving, recently called, QR code to this office's join page |
| Staff console | `/o/:officeId/staff` | **Staff key:** Call Next / Served / No-Show / Recall, pause lines, stats |
| Settings | `/o/:officeId/settings` | **Staff key:** name, services, counters, opening hours, time zone, appointments, demo data |
| Book | `/o/:officeId/book` | Public: book an appointment slot |
| Appointment | `/o/:officeId/appointment/:id` | Public (secret link): confirmation, check-in, cancel |
| Day view | `/o/:officeId/appointments` | **Staff key:** each day's appointments, check in or cancel on someone's behalf |
| Analytics | `/o/:officeId/analytics` | **Staff key:** waits by hour and weekday, tickets per day, no-shows, busiest services, counter times, CSV export |

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

All queue state lives in Redis and the Node process is stateless. Redis keys, sync, isolation and the project layout are in [docs/architecture.md](docs/architecture.md).

## Quick start

```bash
./scripts/up.sh      # sets PUBLIC_URL to your LAN address and your time zone, then docker compose up --build
```

Open <http://localhost:3000> and click **Create an office**. Phones on the same Wi-Fi can scan the lobby QR code. Running without Docker, the CLI and CI are covered in [docs/development.md](docs/development.md). For a real server behind Caddy with HTTPS, see [deploy/README.md](deploy/README.md).

## Engineering problems actually solved

- **A ticket can't be assigned to two counters.** Every queue change is a single Lua script, and Redis runs one script at a time. So Call Next checks the counter, pops the head of the line with one `ZPOPMIN` and assigns it in one atomic step. The tests fire 18 simultaneous calls from 6 counters at 4 tickets and get exactly 4 distinct assignments ([architecture](docs/architecture.md), [concurrency tests](docs/testing.md#queue-and-concurrency)).
- **Priority, appointments and walk-ins share one sorted set per line.** Each ticket's score is `tier × 10¹⁵ + orderAt × 100 + seq mod 100`. Priority comes first, then appointments rank by slot start among walk-ins, with same-millisecond ties kept first-come, first-served. Redis stores scores as 64-bit floats, so every score is kept under 2⁵³ to stay an exact integer ([the formula and the arithmetic](docs/priority-and-appointments.md)).
- **A ticket survives the move to an iPhone Home Screen.** iOS gives the installed app its own storage and opens it at the manifest's `start_url`, and Safari reads the manifest only once, when the page loads. Each ticket has its own address, and the server writes the manifest link into the page, so the saved app opens on the ticket ([the full writeup](docs/ios-home-screen.md)).
- **Alerts never block the queue.** A queue change only publishes an event. A background worker does the scanning, sending and retrying, claiming jobs with leases, and `HSETNX` makes sure each alert is queued only once, even across several server processes ([how alerts work](docs/alerts.md#how-it-works)).
- **The load test found two bottlenecks.** Node closes idle connections after 5 seconds, sooner than the proxy's 2 minutes, so a request occasionally hit a closing connection: a reset here, a 502 behind Caddy. Raising the timeout fixed it. Separately, each ticket room now remembers the last view it sent and skips identical ones, which cut ticket updates by 76% ([methodology and results](docs/load-testing.md)).

## Testing, load and accessibility

- **274 tests against a real Redis:** `npm test`. Details are in [docs/testing.md](docs/testing.md).
- **Load:** 2,000 residents across 100 offices produced 0 errors in 41,839 requests. 95% of API requests took under 4.7 ms, and 95% of calls reached the phone within 33 ms ([docs/load-testing.md](docs/load-testing.md)).
- **Accessibility:** every page and state is checked against WCAG 2.2 AA with axe in English, Spanish and with larger text. The tests also cover keyboard-only use, screen-reader announcements, a larger-text option and reduced motion ([docs/accessibility.md](docs/accessibility.md)).

## More documentation

| Topic | |
| --- | --- |
| [Offices, staff keys and settings](docs/offices-and-settings.md) | staff key hashing, expiry, rate limits, the settings page |
| [Priority, appointments and wait estimates](docs/priority-and-appointments.md) | queue order, slots and check-in windows, estimate ranges |
| [Alerts](docs/alerts.md) | web push and email setup, tunnels, what we learned on real phones, the alert worker |
| [iPhone Home Screen](docs/ios-home-screen.md) | keeping the ticket in a separate storage container, ticket links as capability URLs |
| [Languages](docs/languages.md) | English and Spanish, alerts and announcements in the resident's language, adding a language |
| [Analytics](docs/analytics.md) | the dashboard, definitions, event recording, retention, demo history |
| [Monitoring](docs/monitoring.md) | structured logs, `/health`, error tracking, graceful shutdown |
| [Configuration](docs/configuration.md) | every environment variable |
| [Development](docs/development.md) | Docker and local runs, CI |
| [Limitations](docs/limitations.md) | the full list |

## Demo-scope limitations

- **Staff access:** one shared key per office, with no individual accounts, audit log or key rotation.
- **Opening hours:** one window per day, with no overnight hours or holidays.
- **Alerts:** push and email only, with no SMS. Web push needs HTTPS, and on iPhone it needs the site added to the Home Screen.
- **Languages:** staff pages are English-only, and the Spanish text hasn't had a professional review.

The full list, including upgrade notes, is in [docs/limitations.md](docs/limitations.md).
