#!/usr/bin/env bash
# Build readsb from source and install it as a systemd service.
#
# Written for the skytrace receiver board (ODROID-C2, Armbian/Debian arm64),
# but nothing here is board-specific: any Debian-based host with an RTL-SDR
# works. The board builds on-device (4 cores / 2GB RAM — a couple of minutes).
#
# Run as root on the board:
#   bash install.sh                    # wiedehopf/readsb default branch
#   READSB_REF=v3.14.16 bash install.sh
set -euo pipefail

READSB_REF="${READSB_REF:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

log "== 1. dependencies =="
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential make gcc git ca-certificates pkg-config \
  libusb-1.0-0-dev librtlsdr-dev zlib1g-dev libzstd-dev libncurses-dev \
  rtl-sdr

log "== 2. keep the kernel DVB driver off the dongle =="
echo 'blacklist dvb_usb_rtl28xxu' > /etc/modprobe.d/blacklist-rtlsdr.conf
modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

log "== 3. build readsb =="
rm -rf /tmp/readsb-src
if [ -n "$READSB_REF" ]; then
  git clone --depth 1 --branch "$READSB_REF" https://github.com/wiedehopf/readsb.git /tmp/readsb-src
else
  git clone --depth 1 https://github.com/wiedehopf/readsb.git /tmp/readsb-src
fi
make -C /tmp/readsb-src RTLSDR=yes -j"$(nproc)"

log "== 4. install =="
systemctl stop readsb 2>/dev/null || true
install -m 0755 /tmp/readsb-src/readsb /usr/local/bin/readsb
/usr/local/bin/readsb --version 2>&1 | head -1 || true

if ! id readsb >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin -G plugdev readsb
fi
# Belt and braces alongside the distro librtlsdr udev rules: make sure the
# dongle is group-accessible so readsb can run unprivileged.
cat > /etc/udev/rules.d/60-skytrace-rtlsdr.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0664", GROUP="plugdev"
EOF
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

install -m 0644 "$HERE/readsb.service" /etc/systemd/system/readsb.service
if [ ! -f /etc/default/readsb ]; then
  install -m 0644 "$HERE/readsb.default" /etc/default/readsb
  log "wrote /etc/default/readsb"
else
  log "/etc/default/readsb already exists — leaving it untouched"
fi

systemctl daemon-reload
systemctl enable --now readsb
log "done: readsb is $(systemctl is-active readsb)"
