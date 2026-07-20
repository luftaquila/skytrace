#!/usr/bin/env bash
# One-shot skytrace receiver setup on a fresh Armbian/Debian arm64 board
# (ODROID-C2). Installs readsb (built from source via readsb/install.sh) and
# the skytrace agent, then enables both services.
#
# Requires /etc/skytrace-agent.env to exist already (server URL, receiver id,
# token — see README.md). Run as root:
#   sudo bash receiver/provision.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/luftaquila/skytrace.git}"
AGENT_DIR="${AGENT_DIR:-/opt/skytrace}"
AGENT_ENV="${AGENT_ENV:-/etc/skytrace-agent.env}"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ -f "$AGENT_ENV" ] || die "$AGENT_ENV missing — create it first (see receiver/README.md)"

log "== readsb =="
bash "$HERE/readsb/install.sh"

log "== agent runtime (node.js, no npm deps) =="
apt-get install -y --no-install-recommends nodejs git ca-certificates

log "== skytrace agent =="
if [ -d "$AGENT_DIR/.git" ]; then
  git -C "$AGENT_DIR" pull --ff-only || true
else
  git clone --depth 1 "$REPO_URL" "$AGENT_DIR"
fi
install -m 0644 "$HERE/skytrace-agent.service" /etc/systemd/system/skytrace-agent.service
systemctl daemon-reload
systemctl enable --now skytrace-agent

log "== status =="
systemctl --no-pager --lines=0 status readsb skytrace-agent || true
log "done"
