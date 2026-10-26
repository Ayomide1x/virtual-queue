# Tests

```bash
npm test
```

The tests run against a **real Redis**, so the Lua scripts and their atomicity are actually exercised. The test setup starts a throwaway, non-persistent `redis-server` on port 6399, so your own Redis data is never touched. If `redis-server` isn't installed, point the tests at any Redis:

```bash
docker run --rm -d -p 6399:6379 redis:7-alpine
TEST_REDIS_URL=redis://127.0.0.1:6399 npm test
```

**274 tests in fifteen files**, including:

### Ticket links and the Home Screen

- `ticket-link.test.ts`:
  - ticket pages served with a manifest whose `start_url` is the ticket address; the join page's opens the join page; none on staff pages or malformed addresses; `start_url` can't point at another office or site
  - old `?ticket=` links redirect to the ticket address
  - in a browser: joining reloads onto the ticket address, which opens the ticket in a context with empty storage; an ended ticket lands on the join form with one page load, no loop
  - which ticket wins in Safari and in a Home Screen app (emulated with `navigator.standalone` and the display-mode query), and the fallback when one has ended
  - the "added before joining" message only in the Home Screen app; Copy ticket link, with and without a clipboard; axe on both new states
  - `Referrer-Policy: no-referrer` on pages, the API and static files
  - (a stand-in for Safari vs. the Home Screen app; only a real iPhone confirms what iOS does)
### Monitoring and load

- `monitoring.test.ts`:
  - JSON log lines, levels, error serialization and path redaction
  - per-request logs with request ids, and 5xx logged and tracked without leaking details to the client
  - `/health` returning 200 normally and 503 when Redis is down
  - error tracking: off without a DSN, and with one, events sent to a local fake Sentry with secret ids and personal data stripped
  - browser error reports: logged, tracked, rate-limited and redacted
  - graceful shutdown: in-flight requests finish, new connections are refused and sockets are disconnected
  - the real server process exiting 0 on `SIGTERM` with its shutdown logs
- `api.test.ts`, under load: phones get an update only when their view changes, and the keep-alive timeout outlasts a reverse proxy's.
- A browser test: a crash in the page is reported to the server without the ticket id from the URL.

### Analytics

- `analytics.test.ts`:
  - **The calculations, on hand-built events with known answers:**
    - average and longest wait, average service time and no-show rate
    - recalls not resetting the wait, and walk-outs excluded from waits
    - hour and weekday buckets in the office's time zone across a DST change
    - per-day counts including empty days and tickets served after midnight
    - busiest services with shares, including quiet and since-removed services
    - per-counter service times excluding no-shows
    - an empty range, and a 90-day range computed quickly
  - **CSV:** quoting and formula defusing, office-local times, and the column layout of both exports.
  - **Recording:** every live queue action writes the right event (served, no-show, leaving while waiting or while called, appointment check-in, priority) under a hashed id. History survives a queue reset and has its expiry refreshed.
  - **Seeding:**
    - realistic shape: busy Mondays, a mid-morning peak, a sensible no-show rate, and differing counter speeds
    - idempotent, never overwriting real days, and run through the real demo seed
  - **API:** 401/403, range validation, and CSV headers and file names.
- Browser tests: the dashboard is checked with axe on desktop, and on a phone with every number table open. A behaviour test changes the date range, downloads a CSV, and checks the charts fit a phone screen.

### Accessibility

- `a11y.test.ts`: **axe-core on every page and state**, run in real Chrome against the real server.
  - It checks the WCAG 2.2 A/AA rules plus axe's best-practice rules.
  - Resident pages are checked in **English, Spanish and with Larger text on**.
  - The states covered:
    - the join form, with and without an error
    - a closed line
    - waiting, with the alerts card, the email form, the iPhone install guide and the leave question
    - called, including a recall
    - served
    - booking with every step shown, and booking turned off
    - an appointment: booked, cancel question, cancelled, not found
    - the lobby display, open and closed
    - an office that doesn't exist
    - the home page, before and after creating an office
    - the staff key prompt, including a wrong key
    - the counter picker, and the console with the priority menu open
    - settings and the appointments day view
  - Each check also fails on any JavaScript error in the page.
- `a11y-behaviour.test.ts`, in a real browser:
  - the language menu: switching, remembering, `<html lang>`, and the phone's language on a first visit
  - joining in Spanish stores Spanish on the ticket, and switching updates it
  - the lobby speaks a Spanish resident's call in Spanish and an English resident's in English
  - position announcements, and "your turn" said at once with focus moved
  - joining with the keyboard alone, including the skip link and arrow keys
  - a visible focus ring at every Tab stop
  - Escape and focus return for the leave question and the staff priority menu
  - staff shortcuts switched off
  - focus moving on navigation
  - Larger text scaling, being remembered, and not causing sideways scrolling
  - reduced motion turning animations off
- `language.test.ts`:
  - the language is stored on tickets and appointments, with English as the default
  - unknown languages are rejected
  - a language can be changed only on active tickets, without creating Redis keys
  - the lobby gets each call's language, and still no names
- `alerts.test.ts` also checks Spanish alerts, including the email template, Spanish dates and times in reminders, a language change made after joining, and a checked-in ticket keeping its language.

The browser tests build the web app themselves and use Chrome from puppeteer. If npm skipped puppeteer's download step, which recent npm versions do for install scripts, run `npx puppeteer browsers install chrome`, or point `CHROME_PATH` at an installed Chrome.

### Alerts

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

### Priority, appointments and estimates

- `priority.test.ts`: priority ordering (own join order, unmarking, line isolation, beating appointments), and **concurrent Call Next with mixed priority, appointment and walk-in tickets**. 8 counters × 3 rounds fire at once and every ticket is assigned exactly once, in the exact expected order, checked against the order Redis actually called them in.
- `appointments.test.ts`: slot generation including a DST change, capacity under 10 simultaneous bookings, check-in window edges, too-early and missed, early or late check-in ranking, idempotent and simultaneous check-ins, cancel, the day view, and blocking service removal.
- `estimates.test.ts`: percentile ranges, counter-weighted estimates, shared counters, the rolling time window and its fallback.

### Queue and concurrency

- `queueStore.test.ts` covers queue logic and concurrency.
- `offices.test.ts` covers office creation, key hashing, isolation, settings rules, and TTL/expiry, including an office actually expiring.
- `officeConfig.test.ts` covers opening hours across time zones and settings validation.
- `api.test.ts` covers HTTP and Socket.IO end to end: 401/403 on every staff route, other offices' keys rejected, tickets and live updates confined to their office, staff sockets refused with wrong keys, settings, closed hours, and rate limits.

The queue tests cover ordering, the rolling-average wait estimate, pause/resume, served/no-show/recall, leaving (including leaving *while being called*), calling an empty queue, stale-screen double clicks, privacy of the public payloads, the seed, and the concurrency cases:

- two staff pressing **Call Next** at the same instant on one remaining ticket → exactly one gets it
- 18 simultaneous calls from 6 counters on 4 tickets → 4 distinct assignments, none duplicated ([`queueStore.test.ts`](../server/test/queueStore.test.ts), *many counters calling at once*)
- double-clicking Call Next on one counter → only one resident called
- a resident leaving at the same moment they're called → the state stays consistent
