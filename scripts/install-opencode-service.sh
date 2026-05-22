#!/usr/bin/env bash
# install-opencode-service.sh — install and enable the opencode user systemd service.
#
# Run as yourself (no root / sudo required) from the repository root:
#   bash scripts/install-opencode-service.sh
#
# Idempotent: safe to re-run after updating the unit file.

set -euo pipefail

UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/opencode-server.service"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_DST="${UNIT_DIR}/opencode-server.service"
SERVICE="opencode-server"

# This is a user service — running as root would install it into the wrong manager.
if [[ $EUID -eq 0 ]]; then
  echo "error: do not run this script as root — user services are owned by the user." >&2
  exit 1
fi

echo "==> Creating user unit directory (if missing): ${UNIT_DIR}"
mkdir -p "${UNIT_DIR}"

echo "==> Installing unit file: ${UNIT_DST}"
cp "${UNIT_SRC}" "${UNIT_DST}"
chmod 644 "${UNIT_DST}"

echo "==> Reloading user systemd daemon"
systemctl --user daemon-reload

echo "==> Enabling and starting ${SERVICE} (user)"
systemctl --user enable --now "${SERVICE}"

echo ""
echo "==> Service status:"
systemctl --user status "${SERVICE}" --no-pager || true

echo ""
echo "Follow logs with:  journalctl --user -u ${SERVICE} -f"

echo ""
echo "---"
echo "Port configuration (optional):"
echo "  The service defaults to port 4096. To use a different port without"
echo "  editing the unit file, create an override file:"
echo "    echo \"OPENCODE_PORT=4097\" > ~/.config/opencode/opencode-server.env"
echo "    systemctl --user restart ${SERVICE}"

echo ""
echo "Survive logout (optional, one-time):"
echo "  By default, user services stop when you log out. To keep the server"
echo "  running across sessions (useful for SSH workflows), run once:"
echo "    loginctl enable-linger"
echo "  No root required. Persists across reboots."
