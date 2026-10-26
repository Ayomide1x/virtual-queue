# Deploying on a shared Oracle Cloud ARM server

This guide runs Virtual Queue next to another app on the same Oracle Cloud
Ampere (ARM) Ubuntu instance. Here the other app is a market data pipeline
with its own Docker Compose. One shared **Caddy** serves both apps on separate
domains with automatic HTTPS:

```
                 internet :80 / :443
                         │
                 ┌───────▼────────┐   one Caddy for the whole server
                 │     Caddy      │   (certificates, HTTPS, WebSockets, SSE)
                 └──┬──────────┬──┘
   queue.example.com│          │market.example.com
                    ▼          ▼
         127.0.0.1:3210    127.0.0.1:8080
         Virtual Queue     market pipeline
         (+ its Redis,     (its own Compose project)
          not exposed)
```

**Ground rules:**
- Neither app's Compose file contains a reverse proxy.
- Each app listens only on `127.0.0.1`, on its own port.
- Only Caddy listens on ports 80 and 443.
- Redis has no published port at all. Only the app can reach it, on the Compose project's private network.

Caddy runs in its own small Compose project, so the server ends up with three: this app, the market pipeline, and Caddy. A host-installed Caddy works too ([below](#caddy-installed-on-the-host-instead)).

All the images (`node:22-alpine`, `redis:7-alpine`, `caddy:2`) are multi-arch, so they run natively on ARM. CI builds this app's image for `linux/arm64` on every push.

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

**Don't** add rules for 3210, 8080 or 6379. Those ports stay private.

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

## 3. Install Docker

```bash
# Docker (official convenience script; supports arm64, and starts Docker on boot)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # log out and back in
```

Caddy itself runs as a container (step 6), so there's nothing else to install.

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
- Publish its web port on 127.0.0.1 only, e.g. `ports: ["127.0.0.1:8080:8080"]`.
- Remove any proxy service of its own that binds 80 or 443.

Check nothing else holds 80 or 443:

```bash
sudo ss -tlnp | grep -E ':(80|443)\s'    # should show only caddy
```

## 6. Run Caddy for both sites

Caddy gets its own folder and Compose project, outside both apps. It uses the host's network, so `127.0.0.1:3210` and `127.0.0.1:8080` mean the host, and it binds 80 and 443 on the host directly:

```yaml
# ~/caddy/docker-compose.yml
name: caddy
services:
  caddy:
    image: caddy:2
    network_mode: host          # sees both apps on 127.0.0.1; binds 80/443 on the host
    restart: unless-stopped     # comes back after a reboot, like the two apps
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data        # certificates: keep this volume
      - caddy-config:/config
volumes:
  caddy-data:
  caddy-config:
```

Copy [`Caddyfile.example`](Caddyfile.example) to `~/caddy/Caddyfile`, then replace:
- the domains with yours
- `8080` with the pipeline's port, if it differs
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
	reverse_proxy 127.0.0.1:8080 {
		# The dashboard streams live updates over Server-Sent Events: flush every write, never buffer.
		flush_interval -1
	}
}
```

**Why `flush_interval -1`:** Caddy only skips buffering on its own when it recognizes a response as a stream, such as a `text/event-stream` content type or an unknown length. With `-1` it never buffers this upstream at all, so the pipeline's live updates arrive as they're sent, whatever headers it uses.

```bash
cd ~/caddy
docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile
docker compose up -d
docker compose logs -f caddy      # watch it get both certificates
```

After editing the Caddyfile:

```bash
docker compose exec -w /etc/caddy caddy caddy reload
```

Caddy:
- gets and renews Let's Encrypt certificates for both domains
- redirects HTTP to HTTPS
- passes WebSockets (the queue's live updates) and Server-Sent Events (the pipeline's) through
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
| Caddy | In Docker: `cd ~/caddy && docker compose logs -f caddy`. Installed on the host: `journalctl -u caddy -f`. Add a `log` block to a site for access logs. |

## Caddy installed on the host instead

If you'd rather run Caddy as a system service than a container, install it from Caddy's official apt repository (supports arm64). Skip the `~/caddy` Compose project in step 6:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

The package runs Caddy as a systemd service that starts on boot. Put the same Caddyfile at `/etc/caddy/Caddyfile`, then:

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -f        # watch it get both certificates
```

The firewall steps are the same. Only ports 80 and 443 are opened.

## Verified

**In production.** This guide has been followed end to end on a real Oracle Cloud Ampere (ARM) instance, with Caddy in Docker:
- Both apps are live on their own domains, each with a Let's Encrypt certificate.
- A cold reboot brought all three Compose projects (this app, the market pipeline and Caddy) back with no manual steps.
- The iptables rules for ports 80 and 443 survived the reboot.

**Locally, before that:**
- One Caddy in front of the app on `127.0.0.1:3210` and a stand-in second app ran using Caddy's local certificates on test ports:
  - each domain reached the right app, HTTP redirected to HTTPS, and the app wasn't reachable on the machine's LAN address
  - a 300-resident load test ran *through Caddy* (HTTPS and WebSockets) with no errors: 95% of requests finished within 6 ms, and 95% of calls reached phones within 33 ms
- The app keeps idle connections open longer than Caddy's upstream keep-alive (2 minutes). Otherwise a request can land on a connection the app is just closing, which shows up as an occasional 502.
- Both `linux/arm64` and `linux/amd64` images were built, started, passed `/health`, and shut down cleanly on `docker stop`.
- Server-Sent Events through Caddy 2.11.7 (the `caddy:2` image), with `encode zstd gzip` and `flush_interval -1`, arrived one event at a time.
