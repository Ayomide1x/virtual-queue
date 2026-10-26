# Analytics

Each office has a dashboard at `/o/:officeId/analytics`, linked from the staff console. It needs the staff key.

- **Summary:** tickets, served, average and longest wait, no-show rate, and average service time.
- **Charts:**
  - average and longest wait by the hour people joined
  - average and longest wait by day of the week
  - tickets served per day, with no-shows and people who left
  - busiest services
  - average service time per counter
- **Date range:** last 7, 30 or 90 days, or any From and To dates within the retention period.
- **CSV export** of the selected range, in two files:
  - **Tickets:** one row per ticket, with joined, called and ended times, outcome, counter, and wait and service minutes.
  - **All events:** one row per event.
  - Times are in the office's time zone, and the files open cleanly in Excel. Cells that could run as spreadsheet formulas are defused.
  - Residents' names are never included.

**Definitions** (also shown on the page):
- Times use the office's time zone, and tickets count on the day they joined.
- **Wait** runs from joining to the *first* call; recalls don't restart it. People who left before being called aren't in the wait figures.
- **Service time** runs from the call to *Served*. No-shows are excluded.
- **No-show rate** is no-shows ÷ everyone called (served + no-show).

**How events are recorded without slowing the queue:**
- Every `joined`, `called`, `served`, `no_show` and `left` event is appended to a per-day list, `ev:<YYYY-MM-DD>`, inside the same Lua script as the queue change. That's one `RPUSH`, so events can't be lost, duplicated or recorded out of step with the queue.
- Each event stores its time, the service, the counter, the ticket number, the kind (walk-in or appointment) and any priority reason.
- Tickets are identified by a hash of their id ("visit"), never the secret id itself.
- The dashboard reads only these lists, never the live queue's keys. A 90-day report over about 16,000 tickets takes around 100 ms.
- Clearing the queues (**Reset**, or loading sample residents) keeps the history.

**Retention:** an active office keeps `ANALYTICS_RETENTION_DAYS` (default 90) of history. Older days stop being refreshed and expire, and everything goes when the office expires.

**Sample history:** *Create an office with sample data*, the staff console's *Sample data* panel and `npm run office -- seed <id>` all fill the last 60 days with simulated traffic:
- Mondays are busiest, with a mid-morning rush and a lunch dip, shorter Saturdays and closed Sundays (or your opening hours, if set).
- Counters work at different speeds, and people are served first come, first served.
- A few people give up when the wait gets long, and about 7% are no-shows.
- Days that already have real history are never overwritten, so seeding twice is safe.
