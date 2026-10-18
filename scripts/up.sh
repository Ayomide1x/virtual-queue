#!/usr/bin/env bash
# Starts the whole app in Docker with PUBLIC_URL (your LAN address) and time
# zone filled in, so lobby QR codes work for phones on the same Wi-Fi.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${HOST_IP:-}" ]]; then
  if command -v ipconfig >/dev/null 2>&1; then # macOS
    HOST_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [[ -z "${HOST_IP:-}" ]] && command -v hostname >/dev/null 2>&1; then # Linux
    HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
fi
if [[ -z "${TZ:-}" && -L /etc/localtime ]]; then
  TZ="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
fi
PORT="${PORT:-3000}"
# A PUBLIC_URL in .env (e.g. an HTTPS tunnel) wins over the LAN address.
if [[ -z "${PUBLIC_URL:-}" && -f .env ]]; then
  PUBLIC_URL="$(sed -n 's/^PUBLIC_URL=//p' .env | tail -1)"
fi
if [[ -z "${PUBLIC_URL:-}" && -n "${HOST_IP:-}" ]]; then
  PUBLIC_URL="http://${HOST_IP}:${PORT}"
fi
export HOST_IP TZ PUBLIC_URL

echo "Public URL: ${PUBLIC_URL:-<not set — QR codes will use the address you open the display with>}"
echo "Time zone:  ${TZ:-UTC}"
echo
echo "  Open ${PUBLIC_URL:-http://localhost:${PORT}} and click “Create an office”."
echo "  Or, once it's running:  docker compose exec app node server/dist/cli.js create --seed"
echo
exec docker compose up --build "$@"
