#!/usr/bin/env bash
# install-opencode-service.sh — install and enable the opencode systemd service.
#
# Run once as root or with sudo from the repository root:
#   sudo bash scripts/install-opencode-service.sh
#
# Idempotent: safe to re-run after updating the unit file.

set -euo pipefail

UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/opencode-server.service"
UNIT_DST="/etc/systemd/system/opencode-server.service"
SERVICE="opencode-server"

if [[ $EUID -ne 0 ]]; then
  echo "error: this script must be run as root (or via sudo)" >&2
  exit 1
fi

echo "==> Installing unit file: ${UNIT_DST}"
cp "${UNIT_SRC}" "${UNIT_DST}"
chmod 644 "${UNIT_DST}"

echo "==> Reloading systemd daemon"
systemctl daemon-reload

echo "==> Enabling and starting ${SERVICE}"
systemctl enable --now "${SERVICE}"

echo ""
echo "==> Service status:"
systemctl status "${SERVICE}" --no-pager || true

echo ""
echo "Follow logs with:  journalctl -u ${SERVICE} -f"
