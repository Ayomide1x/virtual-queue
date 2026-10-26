# Load testing

```bash
./scripts/loadtest.sh                                  # 25 offices, 500 residents, 3 min at peak
RESIDENTS=2000 OFFICES=100 HOLD=2m ./scripts/loadtest.sh
BASE_URL=https://queue.example.com ./scripts/loadtest.sh   # an existing server (needs relaxed RATE_LIMIT_* there)
```

[`loadtest/queue.js`](../loadtest/queue.js) is a [k6](https://k6.io) script. The runner starts a throwaway Redis and the production build of the server, with rate limits lifted because every simulated phone shares one IP.

**What it simulates:**
- **Residents** join (30% in Spanish), keep a live connection open on their ticket, and sometimes refresh the page.
  - About 10% also watch the lobby feed.
  - When called, they head to the counter. Otherwise they give up after 1–2 minutes and leave the line.
  - They speak Socket.IO's wire protocol over a raw WebSocket, so each one behaves like a real phone: connect, subscribe, answer heartbeats.
- **Staff** at 3 counters per office call the next ticket, serve for 3–8 s, and mark them served (6% no-shows).
- A **lobby TV and a staff console** per office receive every update.

**Measures:**
- API latency per action
- WebSocket connect time
- **call → phone**: from staff pressing *Call Next* to the resident's phone receiving "called". It's measured against the server's `calledAt`, on the same clock.
- update rates, errors, and the server's CPU and memory

**Results** (Apple M5, 10 cores. Node 24 production build, Redis 7, and k6 2.3 all on the same machine, so k6's CPU use is included):

| | 500 residents · 25 offices · 75 staff · 50 screens | 2,000 residents · 100 offices · 300 staff · 200 screens |
| --- | --- | --- |
| Requests | 13,566 (49/s) | 41,839 (195/s) |
| API latency p95 / p99 | **3.9 ms** / 7.7 ms | **4.7 ms** / 11.4 ms |
| Join · Call Next · Served (p95) | 4.7 · 4.0 · 3.7 ms | 4.8 · 5.3 · 4.6 ms |
| Call → phone p50 / p95 / max | 30 / **33** / 71 ms | 28 / **33** / 76 ms |
| WebSocket connect p95 | 4 ms | 4 ms |
| Errors | **0** of 13,566 | **0** of 41,839 |
| Server CPU (peak, % of one core) · memory | 42% · 294 MB | 71% · 427 MB |

About 25 ms of "call → phone" is deliberate: changes are batched for 25 ms, so a burst of changes becomes one broadcast per office.

**Bottlenecks found and fixed:**

| Problem | Effect | Fix |
| --- | --- | --- |
| Node closes idle keep-alive connections after 5 s. Staff pause about 5 s between actions, so a request sometimes went out just as the server closed its connection | **One "connection reset" per run.** Behind a proxy this shows up as occasional 502s | `keepAliveTimeout` raised to 125 s, longer than Caddy's 2-minute upstream keep-alive, and graceful shutdown now closes kept-alive connections as they go idle |
| Every change in an office re-sent a ticket update to every phone in it, even when that phone's view was identical | 551 updates/s at 500 residents, and 2,074/s at 2,000 | Each ticket room remembers what it was last sent, and identical views are skipped: **133/s (−76%)** and **485/s (−77%)**. Data sent to clients fell from 211 to 133 MB and from 597 to 409 MB |

Each fix has a test: an update is sent only when the view changes, the keep-alive outlasts the proxy, and shutdown stays prompt with kept-alive connections. The test setup above was also run through Caddy over HTTPS (see [deploy/README.md](../deploy/README.md#verified)).
