# Priority, appointments and wait estimates

## Queue order

Each line is one Redis sorted set, scored as

```
tier × 10¹⁵  +  orderAt × 100  +  seq mod 100        (tier 0 = priority, 1 = regular)
```

- **Priority tickets** come first, in their own **join order**, not the order staff marked them in. Staff give a waiting ticket priority from the star next to it in the console and pick a reason: disability, senior, returning no-show, or other. The reason is shown to staff only, never on public screens. Marking or unmarking is a Lua script that rescores the ticket atomically.
- **`orderAt`** is the join time for walk-ins and the **slot start** for checked-in appointments. An appointment therefore goes ahead of walk-ins who joined after its slot time and behind those who joined before it, whether the resident checks in early or late.
- `seq` breaks ties within the same millisecond, so ties stay first-come, first-served. Every score stays below 2⁵³, so Redis compares them exactly.

**Why every score stays under 2⁵³.** Redis stores sorted-set scores as 64-bit floating-point numbers, which represent every integer exactly only up to 2⁵³ (about 9.007 × 10¹⁵). Above that, neighbouring integers round to the same value, so two tickets could tie or swap places. The formula is sized to stay well below the limit:

- `orderAt` is a millisecond timestamp, about 1.8 × 10¹² today, so `orderAt × 100` is about 1.8 × 10¹⁴.
- The tier adds 0 or 10¹⁵, and `seq mod 100` adds at most 99.
- The largest score today is therefore about 1.18 × 10¹⁵, roughly an eighth of 2⁵³. The tiers can't overlap until `orderAt × 100` reaches 10¹⁵ (timestamps around the year 2286), and scores stay exact integers until about the year 4500.

Because every score is an exact integer, `ZPOPMIN` always takes the right ticket, and priority, appointment and walk-in order can all live in one sorted set per line.
- Call Next is still a single `ZPOPMIN` on the lowest score, so mixed priority, appointment and walk-in traffic stays atomic. "Any line" takes the lowest score across lines, so priority tickets anywhere go first.

## Appointments

- **Slots** come from the weekly hours table, in the office's time zone and correct across daylight-saving changes. They use the configured **slot length**, with a **capacity per slot per service** and a **booking horizon** in days. Slots come from the hours table even when "only allow joining during opening hours" is off.
- **Booking** is a Lua script that checks and increments the slot's count, so simultaneous bookings can never overfill a slot. The resident gets a **confirmation link** with a secret ID and a short reference code like `KHAVW7`, and can **cancel**, which frees the place.
- **Check-in** happens from the confirmation link, or by staff from the day view. It is allowed from *early* minutes before to *late* minutes after the slot (15 and 10 by default):
  - too early: refused, with "Check-in opens at 9:45 AM"
  - within the window: becomes a ticket with `orderAt` = slot start
  - after the window: the appointment is **missed**
  - checking in twice returns the same ticket
- **Missed appointments** are persisted at check-in time, by a 30-second sweep, and when staff open the day view. Appointment data expires two days after its slot.
- A service can't be removed while it has upcoming bookings.

## Wait estimates

- **Service time** is the mean and quartiles of recent service durations. Each duration is stored with its end time; durations from the last 3 hours are used when there are at least 3, otherwise the last 20 recorded, otherwise the service's default.
- **Active counters** come from each counter's calls in the last 30 minutes, split across the lines it called from. A counter alternating between two lines counts as 0.5 for each. A counter still busy with someone called earlier counts fully for that line.
- **Estimate** = people ahead × mean ÷ counters, shown as a **range** from the 25th to 75th percentile service times ("8–12 min"). With fewer than 3 samples the range is −25 % / +30 % around the mean.
