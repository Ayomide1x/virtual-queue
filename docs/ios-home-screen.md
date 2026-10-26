# Keeping a ticket on the iPhone Home Screen

**iPhone/iPad** (iOS 16.4+) only allow web push for sites added to the Home Screen. The join page is an installable PWA, with a per-office manifest, a service worker and icons. iPhone users who haven't installed it see a 3-step visual guide on their ticket page: Share → Add to Home Screen → open the app and tap Notify me.

## How a ticket survives the move to the Home Screen

iOS gives a Home Screen app its own storage, separate from Safari, and opens it at the manifest's `start_url`. Safari reads the manifest once, when a page loads, and ignores later changes to it. So:

- Every ticket has its own address, `/o/<office>/t/<ticket id>`. Old `/o/<office>/join?ticket=…` links (alerts already sent, icons already installed) redirect to it.
- Joining (or checking in for an appointment) loads the ticket address as a fresh page, rather than changing the route inside the app.
- The server writes the manifest link into the HTML of resident pages. On a ticket address, `start_url` is that address, before any JavaScript runs. Whichever URL iOS saves, the page's or the manifest's, it carries the ticket.
- **Which ticket wins depends on where the page runs.**
  - **In Safari** (any browser tab), the ticket in the address comes first, then the one stored on the device. The resident opened that link, so that's the ticket they mean.
  - **In a Home Screen app**, storage comes first, then the address. An installed icon's `start_url` is frozen at the ticket it was installed with, and iOS never updates it when the resident joins again inside the app, so only the app's storage knows about a newer ticket.
  - **If the first ticket has already ended** (expired, left or finished), the page falls back to the other one. A ticket that ends while it's on screen is shown as ended; it isn't swapped for another.
  - **How the page tells them apart:** `isStandalone()` in `web/src/lib/pwa.ts` checks `navigator.standalone` (iOS) and the `display-mode: standalone` media query. It's the same check that chooses between the install guide and the **Notify me** button, and on an iPhone it's false in Safari and true in the installed app.
- **An app added before joining** has its own, empty storage, so it can't see a ticket joined later in Safari. On iPhone, the app's join page says so: open the ticket in Safari and add it to the Home Screen from that page. The install guide only appears on the ticket page, which makes this rare.
- **Copy ticket link** on the ticket page copies the ticket address, to keep or open on another device. If the clipboard isn't available, the link is shown to copy by hand.

## Ticket links are capability URLs

Ticket ids are random UUIDs (`crypto.randomUUID()`, 122 random bits), so they can't be guessed or enumerated. The short ticket number on the lobby screen (e.g. A-042) is separate and grants nothing. Anyone who *has* the link can see the resident's name, place and service, leave the line for them, and turn their alerts on or off (they see only a masked email). The id was already in the address bar and in alert links. Giving it its own address makes the link more likely to be bookmarked or shared, but it doesn't expose anything new. The link stops working when the ticket ends. Every response carries `Referrer-Policy: no-referrer`, so ticket addresses are never sent to other sites. Our logs and error reports (including what the browser sends) replace ids with `:id`. Caddy doesn't log requests unless you add a `log` block, but a proxy or tunnel in between (e.g. Cloudflare) can see full URLs.

See also: [alerts.md](alerts.md) for push setup, and the tests in [testing.md](testing.md#ticket-links-and-the-home-screen).
