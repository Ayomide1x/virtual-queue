# Deploying on a shared Oracle Cloud ARM server

This guide runs Virtual Queue next to another app on the same Oracle Cloud
Ampere (ARM) Ubuntu instance. Here the other app is a market data pipeline
with its own Docker Compose. One shared **Caddy** serves both apps on separate
domains with automatic HTTPS:

```
                 internet :80 / :443
                         │
                 ┌───────▼────────┐   one Caddy for the whole server
                 │     Caddy      │   (certificates, HTTPS, WebSockets)
                 └──┬──────────┬──┘
   queue.example.com│          │market.example.com
                    ▼          ▼
         127.0.0.1:3210    127.0.0.1:8000
         Virtual Queue     market pipeline
         (+ its Redis,     (its own Compose project)
          not exposed)
```

**Ground rules:**
- Neither app's Compose file contains a reverse proxy.
- Each app listens only on `127.0.0.1`, on its own port.
- Only Caddy listens on ports 80 and 443.
- Redis has no published port at all. Only the app can reach it, on the Compose project's private network.

Both images (`node:22-alpine`, `redis:7-alpine`, `caddy`) are multi-arch, so they run natively on ARM. CI builds this app's image for `linux/arm64` on every push.

## 1. DNS

Create an **A record** for each domain pointing at the instance's public IP, and an AAAA record if you use IPv6:

| Name | Type | Value |
| --- | --- | --- |
| `queue.example.com` | A | `<instance public IP>` |
| `market.example.com` | A | `<instance public IP>` |

Do this first. Caddy needs the names to resolve to this server before it can get certificates.

## 2. Open ports 80 and 443

Oracle blocks traffic in **two places**, and you need to open both.

### a) Oracle Cloud security list (the cloud firewall)

1. In the Oracle Cloud Console, go to **Networking → Virtual cloud networks →** your VCN **→ Subnets →** the instance's subnet.
2. Open the subnet's **security list** (e.g. *Default Security List for …*).
3. Choose **Add Ingress Rules** and add two rules:

| Stateless | Source CIDR | IP protocol | Destination port |
| --- | --- | --- | --- |
| No | `0.0.0.0/0` | TCP | `80` |
| No | `0.0.0.0/0` | TCP | `443` |

Optionally add UDP `443` for HTTP/3. If your instance uses a **Network Security Group** instead, add the same rules there.

**Don't** add rules for 3210, 8000 or 6379. Those ports stay private.

### b) The server's own firewall

Oracle's Ubuntu images ship with **iptables** rules that reject almost everything, even after the security list allows it. Insert ACCEPT rules *before* the final REJECT rule:

```bash
sudo iptables -L INPUT --line-numbers          # note the number of the "REJECT … reject-with icmp-host-prohibited" line
sudo iptables -I INPUT <that number> -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT <that number> -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save                  # keep the rules after a reboot
```

If you use **ufw** instead of the stock iptables rules:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

> **Why bind to 127.0.0.1?** Ports Docker publishes on `0.0.0.0` skip the host firewall (Docker writes its own iptables rules). A port published as `127.0.0.1:3210` can only be reached from the server itself, whatever the firewall says. That's why both apps' Compose files must publish to `127.0.0.1`.

## 3. Install Docker and Caddy

```bash
# Docker (official convenience script; supports arm64)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # log out and back in

# Caddy (official apt repository; supports arm64)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

The apt package runs Caddy as a systemd service that starts on boot.

If you'd rather run Caddy in a container, see [Caddy in Docker](#caddy-in-docker-instead) below.

## 4. Run Virtual Queue

```bash
git clone https://github.com/Ayomide1x/virtual-queue.git && cd virtual-queue
cp deploy/env.production.example .env
nano .env    # set PUBLIC_URL, TZ, and optionally SENTRY_DSN and the alert keys
```

The settings that matter for this setup (already in the example):

```bash
BIND_IP=127.0.0.1                     # only reachable from this machine (Caddy)
PORT=3210                             # unlikely to clash; check with: sudo ss -tlnp | grep 3210
PUBLIC_URL=https://queue.example.com  # lobby QR codes and alert links use this
TRUST_PROXY=1                         # Caddy is one proxy hop; rate limits see real client IPs
```

**Push alerts:** to turn them on, generate VAPID keys once and paste them into `.env`. This needs no Node.js on the host:

```bash
docker run --rm node:22-alpine npx -y web-push generate-vapid-keys
```

Start it:

```bash
APP_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
curl -s http://127.0.0.1:3210/health    # {"status":"ok",...}
docker compose ps                       # app and redis "healthy"; only 127.0.0.1:3210 is published
```

The Compose project is named `virtual-queue`, so its containers, network and Redis volume never collide with the market pipeline's.

## 5. The market pipeline

In the *other* app's `docker-compose.yml`:
- Publish its web port on 127.0.0.1 only, e.g. `ports: ["127.0.0.1:8000:8000"]`.
- Remove any proxy service of its own that binds 80 or 443.

Check nothing else holds 80 or 443:

```bash
sudo ss -tlnp | grep -E ':(80|443)\s'    # should show only caddy
```

## 6. Configure Caddy for both sites

Copy [`Caddyfile.example`](Caddyfile.example) to `/etc/caddy/Caddyfile`, then replace:
- the domains with yours
- `8000` with the pipeline's port
- the `email` with an address you read

```caddyfile
{
	email you@example.com
}

queue.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3210 {
		health_uri /health
		health_interval 10s
	}
}

market.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8000
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -f        # watch it get both certificates
```

Caddy:
- gets and renews Let's Encrypt certificates for both domains
- redirects HTTP to HTTPS
- passes WebSockets (the queue's live updates) through on its own
- adds `X-Forwarded-For` and `X-Forwarded-Proto`

Check from anywhere:

```bash
curl -s https://queue.example.com/health
curl -sI https://market.example.com
```

Then open `https://queue.example.com`, create an office, and scan the lobby QR code with a phone. Web push works because the site is on HTTPS. On an iPhone, add the page to the Home Screen first.

## Updating

```bash
cd virtual-queue && git pull
APP_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
```

The old container gets `SIGTERM` and has 20 seconds (`stop_grace_period`) to shut down gracefully:
- It finishes in-flight requests and any alert sends under way.
- Phones and screens reconnect on their own to the new container, which typically takes under a second.

Queue state lives in Redis (with an append-only file on a volume), so nobody loses their place.

## Monitoring

| What | How |
| --- | --- |
| Health | `GET /health` gives `200 {"status":"ok"}` when the app and Redis are fine, or `503` with `redis_unavailable` / `shutting_down`. Caddy uses it (`health_uri`), and so does Docker's healthcheck. Point an uptime monitor at `https://queue.example.com/health`. |
| Logs | `docker compose logs -f app`. One JSON object per line (`time`, `level`, `msg`, `requestId`, …). Secret ticket ids and query strings are stripped from paths. Docker rotates them (5 × 10 MB). |
| Errors | Set `SENTRY_DSN` (Sentry or GlitchTip) in `.env` and restart. Server errors, crashed background jobs and browser crashes are reported, without personal data. |
| Caddy | `journalctl -u caddy`. Add a `log` block to a site for access logs. |

## Caddy in Docker instead

If you'd rather not install Caddy on the host, run it as its own Compose project. Give it the host's network so `127.0.0.1:3210` and `127.0.0.1:8000` mean the host, as they do for a host-installed Caddy:

```yaml
# ~/caddy/docker-compose.yml (its own folder, not inside either app)
name: caddy
services:
  caddy:
    image: caddy:2
    network_mode: host          # sees both apps on 127.0.0.1; binds 80/443 on the host
    restart: unless-stopped
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data        # certificates: keep this volume
      - caddy-config:/config
volumes:
  caddy-data:
  caddy-config:
```

```bash
cd ~/caddy && docker compose up -d
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile   # after editing the Caddyfile
```

The firewall steps are the same. Only ports 80 and 443 are opened.

## Checked before writing this

- This exact Caddyfile layout ran locally, using Caddy's local certificates on test ports:
  - one Caddy in front of the app on `127.0.0.1:3210` and a stand-in second app on `127.0.0.1:8000`
  - each domain reached the right app, HTTP redirected to HTTPS, and the app wasn't reachable on the machine's LAN address
  - a 300-resident load test ran *through Caddy* (HTTPS and WebSockets) with no errors: 95% of requests finished within 6 ms, and 95% of calls reached phones within 33 ms
- The app keeps idle connections open longer than Caddy's upstream keep-alive (2 minutes). Otherwise a request can land on a connection the app is just closing, which shows up as an occasional 502.
- Both `linux/arm64` and `linux/amd64` images were built, started, passed `/health`, and shut down cleanly on `docker stop`.
