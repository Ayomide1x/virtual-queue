# Alerts: web push, with email as a fallback

Residents can turn on alerts after joining, or after booking an appointment. They get:

- **"Almost your turn"** when 3 or fewer people are ahead. It isn't sent if they were already that close when they opted in.
- **"It's your turn: go to Window A"** when called.
- **A reminder 1 hour before an appointment.** It isn't sent if they booked less than an hour ahead. After check-in, the same contact details also get the two alerts above.
- A one-time **"Alerts are on"** confirmation per channel, so residents know it works.

## Setup

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

**iPhone/iPad** (iOS 16.4+) only allow web push for sites added to the Home Screen. The join page is an installable PWA, with a per-office manifest, a service worker and icons. iPhone users who haven't installed it see a 3-step visual guide on their ticket page: Share → Add to Home Screen → open the app and tap Notify me.

How a resident's ticket survives the move to the Home Screen, and why ticket links are safe to share as capability URLs, is in [ios-home-screen.md](ios-home-screen.md).

## How it works

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
