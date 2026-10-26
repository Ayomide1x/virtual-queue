# Demo-scope limitations

- Staff access is a single shared key per office, with no individual accounts, no audit log and no key rotation. If the staff link leaks, create a new office.
- Opening hours are one window per day, with no overnight hours or holidays. Appointment slots follow the same limits.
- Alerts use free channels only, push and email. There is no SMS.
- Staff pages are English-only. Service and counter names aren't translated.
- The Spanish text was written for this demo and hasn't been reviewed by a professional translator. Have it reviewed before real use.
- Web push needs HTTPS, so on a plain-http LAN demo phones get email instead. iPhones also need the site added to the Home Screen.
- Waiting tickets created by the earlier version use the old scoring. Reseed or clear existing offices after upgrading.
- Upgrading from the single-office version leaves its old `vq:*` keys in Redis unused. Run `docker compose down -v` for a clean slate.
