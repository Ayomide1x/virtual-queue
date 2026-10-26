# Scope

What this project covers, what it deliberately leaves out, and what a production deployment would need to add.

**Covered:** walk-in queues and appointments across many isolated offices, priority ordering, wait estimates, web push and email alerts, resident pages in English and Spanish, and per-office analytics.

## Staff access

Staff auth is a single shared key per office. Individual accounts, an audit log and key rotation would be the first additions for real use. Until then, the answer to a leaked staff link is a new office.

## Opening hours and appointments

Opening hours are one window per day. Overnight hours and holidays aren't modelled, and appointment slots follow the same rules. An office with overnight shifts or holiday closures would need both added.

## Alerts

- **Channels:** alerts use free channels only, web push and email. SMS is out of scope, and a deployment that needs it would add it as a third channel.
- **HTTPS:** web push needs HTTPS, which the [deployment guide](../deploy/README.md) provides. On a plain-http LAN setup, phones are offered email instead.
- **iPhone:** web push also needs the site added to the Home Screen. That's an iOS rule, and the ticket page guides residents through it.

## Languages

- **Staff pages are English-only.** Service and counter names are shown as staff typed them, without translation.
- **Spanish:** the text hasn't been reviewed by a professional translator. That review comes before real use.

## Upgrading from earlier versions

- Waiting tickets created by the earlier version use the old scoring. Reseed or clear existing offices after upgrading.
- Upgrading from the single-office version leaves its old `vq:*` keys in Redis unused. Run `docker compose down -v` for a clean slate.
