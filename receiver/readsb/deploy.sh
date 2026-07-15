#!/usr/bin/env bash
# Deploy readsb onto the skytrace receiver (Orange Pi i96), replacing
# dump1090-mutability, and point the skytrace agent at readsb's aircraft.json.
#
# Safe by design: it stops mutability, starts readsb, and verifies readsb is
# actually producing fresh JSON with enough RAM headroom. If verification
# fails it AUTO-REVERTS to dump1090-mutability so the receiver keeps feeding.
#
# Run as root ON THE BOARD. The board WiFi flaps, so run it detached and poll
# the log, e.g.:
#   sudo READSB_BIN=/tmp/readsb bash deploy.sh >/tmp/readsb-deploy.log 2>&1 &
#
# Binary source:
#   READSB_BIN=/path/to/readsb   use a local binary (e.g. scp'd in), or
#   (default)                    download the CI release asset via curl.
set -euo pipefail

RELEASE_URL="${RELEASE_URL:-https://github.com/luftaquila/skytrace/releases/download/readsb-armhf/readsb}"
READSB_BIN="${READSB_BIN:-}"
AGENT_ENV="${AGENT_ENV:-/etc/skytrace-agent.env}"
JSON_PATH="/run/readsb/aircraft.json"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

revert() {
  log "!! verification failed — reverting to dump1090-mutability"
  systemctl stop readsb 2>/dev/null || true
  systemctl disable readsb 2>/dev/null || true
  systemctl enable --now dump1090-mutability 2>/dev/null || true
  log "reverted. dump1090-mutability status:"
  systemctl is-active dump1090-mutability || true
  exit 1
}

log "== 1. runtime dependencies =="
# librtlsdr0/libusb-1.0-0 are already present (used by mutability); readsb also
# needs libzstd1 and libncurses6/libtinfo6.
apt-get update -qq || true
apt-get install -y --no-install-recommends libzstd1 libncurses6 libtinfo6 librtlsdr0 libusb-1.0-0

log "== 2. readsb user =="
if ! id readsb >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin -G plugdev readsb
else
  usermod -aG plugdev readsb || true
fi

log "== 3. install binary =="
if [ -n "$READSB_BIN" ]; then
  [ -f "$READSB_BIN" ] || die "READSB_BIN=$READSB_BIN not found"
  install -m 0755 "$READSB_BIN" /usr/local/bin/readsb
else
  log "downloading $RELEASE_URL"
  curl -fL --retry 5 --retry-delay 3 -o /tmp/readsb.dl "$RELEASE_URL" || die "download failed"
  install -m 0755 /tmp/readsb.dl /usr/local/bin/readsb
fi
file /usr/local/bin/readsb || true
/usr/local/bin/readsb --version 2>&1 | head -1 || true

log "== 4. install unit + env =="
install -m 0644 "$HERE/readsb.service" /etc/systemd/system/readsb.service
if [ ! -f /etc/default/readsb ]; then
  install -m 0644 "$HERE/readsb.default" /etc/default/readsb
  log "wrote /etc/default/readsb — EDIT --lat/--lon before relying on positions"
else
  log "/etc/default/readsb already exists — leaving it untouched"
fi
systemctl daemon-reload

log "== 5. switch decoder (single RTL dongle — only one may run) =="
systemctl disable --now dump1090-mutability 2>/dev/null || true
systemctl enable --now readsb

log "== 6. verify readsb output + RAM =="
ok=0
for i in $(seq 1 20); do
  sleep 2
  if [ -s "$JSON_PATH" ] && python3 -c "import json,sys;d=json.load(open('$JSON_PATH'));sys.exit(0 if 'aircraft' in d else 1)" 2>/dev/null; then
    ok=1; break
  fi
  log "  waiting for $JSON_PATH ($i/20)"
done
[ "$ok" = 1 ] || revert

avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
log "MemAvailable: ${avail} MB"
[ "${avail:-0}" -ge 15 ] || { log "MemAvailable too low"; revert; }
if dmesg 2>/dev/null | tail -50 | grep -qi 'Out of memory\|oom-kill'; then
  log "OOM detected in dmesg"; revert
fi
log "readsb producing JSON, RAM ok. aircraft in file: $(python3 -c "import json;print(len(json.load(open('$JSON_PATH')).get('aircraft',[])))" 2>/dev/null || echo '?')"

log "== 7. point skytrace agent at readsb =="
if [ -f "$AGENT_ENV" ]; then
  cp -a "$AGENT_ENV" "$AGENT_ENV.bak.$(date +%s)"
  # comment any URL source, set the readsb file path
  sed -i 's|^\s*SKYTRACE_AIRCRAFT_URL=|#SKYTRACE_AIRCRAFT_URL=|' "$AGENT_ENV"
  if grep -q '^\s*#*\s*SKYTRACE_AIRCRAFT_FILE=' "$AGENT_ENV"; then
    sed -i "s|^\s*#*\s*SKYTRACE_AIRCRAFT_FILE=.*|SKYTRACE_AIRCRAFT_FILE=$JSON_PATH|" "$AGENT_ENV"
  else
    echo "SKYTRACE_AIRCRAFT_FILE=$JSON_PATH" >> "$AGENT_ENV"
  fi
  systemctl restart skytrace-agent 2>/dev/null || log "restart skytrace-agent manually"
  log "agent env updated (backup alongside)."
else
  log "WARN: $AGENT_ENV not found — set SKYTRACE_AIRCRAFT_FILE=$JSON_PATH yourself"
fi

log "== DONE =="
systemctl --no-pager -l status readsb | head -6 || true
