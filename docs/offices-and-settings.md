# Offices, staff keys and settings

# Offices and staff keys

- Creating an office returns a random **office ID** and a secret **staff key**. Only a SHA-256 hash of the key is stored, so a lost key can't be recovered. Create a new office instead.
- The staff link looks like `/o/<id>/staff#key=<key>`. The key sits in the URL *fragment*, which browsers never send to the server or put in referrers. On first visit the page saves it to `localStorage` and removes it from the address bar. Staff can also paste the link or key into the "Staff access" form.
- Staff API calls send the key in the `X-Staff-Key` header. A missing key returns **401** and a wrong key, including another office's key, returns **403**. The staff Socket.IO subscription checks the key the same way. The display and join pages need no key.
- **Expiry:** an office and all its data expire after **30 days without activity** (`OFFICE_TTL_DAYS`). Every key an office writes gets a TTL in the same atomic step, and any request or socket subscription refreshes them. Unknown or expired offices show a clear "We couldn't find this office" page, and the API returns `404 office_not_found`.
- **Rate limits (per IP, stored in Redis):** creating offices is limited to 10 per hour (`RATE_LIMIT_CREATE_OFFICE=10/3600`) and joining a line to 30 per minute (`RATE_LIMIT_JOIN=30/60`). Over the limit the API returns 429 with `Retry-After`. Behind a reverse proxy, set `TRUST_PROXY` so the limits see real client IPs.

# Settings

Staff open **Settings** from the console. Changes apply to every open screen immediately.

- **Office:** name and **time zone**. Opening hours and "today" stats use the office's time zone, not the server's.
- **Services:** add, rename or remove services, and set each one's ticket letter (unique) and default service time, which is used for wait estimates until real data exists. Renaming keeps people in line. A service can't be removed while anyone is waiting in it or being served.
- **Counters:** add, rename or remove. Names like "Window A" appear on the display and in residents' alerts. A counter can't be removed while it's serving someone.
- **Opening hours:** per weekday, optional. Outside opening hours the join page shows "The line is closed — We open again Monday at 9:00 AM" and the display shows a banner. Staff can still serve people already in line. Pages update by themselves when the office opens or closes.
- **Demo data:** *Fill with sample residents* or *Clear all queues*.

New offices start with three services (Driver's License, Vehicle Registration, ID Card), four counters, and opening hours **switched off**, so a demo works at any time of day.
