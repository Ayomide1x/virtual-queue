#!/usr/bin/env bash
# Starts the whole app in Docker with the LAN IP and time zone filled in,
# so the lobby QR code works for phones on the same Wi-Fi.
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
export HOST_IP TZ

PORT="${PORT:-3000}"
echo "LAN IP:    ${HOST_IP:-<not found — QR code will use the address you open the display with>}"
echo "Time zone: ${TZ:-UTC}"
echo
echo "  Resident:  http://${HOST_IP:-localhost}:${PORT}/join"
echo "  Staff:     http://localhost:${PORT}/staff"
echo "  Display:   http://localhost:${PORT}/display"
echo
exec docker compose up --build "$@"
