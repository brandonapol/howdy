#!/usr/bin/env bash
set -euo pipefail

# Installs Howdy as a systemd *user* service. Run as the account the bots
# should act as - the same one `gh auth login` and `claude setup-token` were
# run as. Do not run this with sudo.

if [[ ${EUID} -eq 0 ]]; then
  echo "Run this as your normal user, not root." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
units="${HOME}/.config/systemd/user"
root="${HOWDY_ROOT:-${HOME}/.howdy}"

node_major="$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [[ "${node_major}" -lt 22 ]]; then
  echo "Node 22 or newer is required (found: $(node --version 2>/dev/null || echo none))." >&2
  echo "On Debian/Ubuntu arm64: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi

echo "==> Installing dependencies"
cd "${here}"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

echo "==> Building"
npm install
npm run build

echo "==> Preparing ${root}"
mkdir -p "${root}/bots" "${root}/workspaces" "${root}/backups"
chmod 700 "${root}"

if [[ ! -f "${root}/env" ]]; then
  cat > "${root}/env" <<ENVEOF
# Howdy configuration. This file is read by the service; keep it chmod 600.
# HOWDY_SECRET=change-me-if-your-lan-is-shared
HOWDY_DAILY_TOKEN_CEILING=2000000
HOWDY_WEEKLY_TOKEN_CEILING=10000000
HOWDY_TURN_TIMEOUT_MS=180000
ENVEOF
  chmod 600 "${root}/env"
  echo "    wrote ${root}/env"
fi

echo "==> Installing units into ${units}"
mkdir -p "${units}"
install -m 644 "${here}/ops/howdy.service" "${units}/howdy.service"
install -m 644 "${here}/ops/howdy-backup.service" "${units}/howdy-backup.service"
install -m 644 "${here}/ops/howdy-backup.timer" "${units}/howdy-backup.timer"

systemctl --user daemon-reload
systemctl --user enable --now howdy.service
systemctl --user enable --now howdy-backup.timer

# Keep the service alive after you log out of ssh.
loginctl enable-linger "${USER}" 2>/dev/null || \
  echo "    could not enable linger; run: sudo loginctl enable-linger ${USER}"

echo
echo "==> Done."
echo "    Status:  systemctl --user status howdy"
echo "    Logs:    journalctl --user -u howdy -f"
echo "    Open:    http://$(hostname -I 2>/dev/null | awk '{print $1}'):${HOWDY_PORT:-4747}"
echo
echo "    If you have not already, authenticate Claude as this user:"
echo "      claude setup-token"
