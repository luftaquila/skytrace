#!/usr/bin/env bash
# Build readsb from source and install it as a systemd service.
#
# Written for the skytrace receiver board (ODROID-C2, Armbian/Debian arm64),
# but nothing here is board-specific: any Debian-based host with an RTL-SDR
# works. The board builds on-device (4 cores / 2GB RAM — a couple of minutes).
#
# Run as root on the board:
#   bash install.sh                    # maintainer-pinned immutable commit
#   READSB_COMMIT=<full-40-char-commit> bash install.sh
set -euo pipefail

READSB_COMMIT="${READSB_COMMIT:-60d576ba9ecf8815fddcf81f6c585663fb9bf5fa}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD_ROOT=""

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }
cleanup() {
  if [ -n "$BUILD_ROOT" ] && [ -d "$BUILD_ROOT" ]; then
    rm -rf -- "$BUILD_ROOT"
  fi
}
trap cleanup EXIT

[ "$(id -u)" = 0 ] || die "must run as root"
[[ "$READSB_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || die "READSB_COMMIT must be a full lowercase 40-character commit"
[ -z "${READSB_REF:-}" ] || die "READSB_REF was removed; use an immutable READSB_COMMIT"

log "== 1. dependencies =="
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential make gcc git ca-certificates pkg-config \
  libusb-1.0-0-dev librtlsdr-dev zlib1g-dev libzstd-dev libncurses-dev \
  rtl-sdr procps

log "== 2. keep the kernel DVB driver off the dongle =="
echo 'blacklist dvb_usb_rtl28xxu' > /etc/modprobe.d/blacklist-rtlsdr.conf
modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

log "== 3. build readsb =="
if ! id readsb-build >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin readsb-build
fi
BUILD_ROOT="$(mktemp -d /var/tmp/readsb-build.XXXXXX)"
SOURCE_DIR="$BUILD_ROOT/src"
chown readsb-build:readsb-build "$BUILD_ROOT"
chmod 0700 "$BUILD_ROOT"
runuser -u readsb-build -- env HOME="$BUILD_ROOT" git init -q "$SOURCE_DIR"
runuser -u readsb-build -- env HOME="$BUILD_ROOT" git -C "$SOURCE_DIR" remote add origin \
  https://github.com/wiedehopf/readsb.git
runuser -u readsb-build -- env HOME="$BUILD_ROOT" git -C "$SOURCE_DIR" fetch \
  --depth 1 origin "$READSB_COMMIT"
FETCHED_COMMIT="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
[ "$FETCHED_COMMIT" = "$READSB_COMMIT" ] || die "fetched readsb revision does not match READSB_COMMIT"
runuser -u readsb-build -- env HOME="$BUILD_ROOT" git -C "$SOURCE_DIR" \
  -c advice.detachedHead=false checkout --detach "$READSB_COMMIT"
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$READSB_COMMIT" ] \
  || die "checked out readsb revision does not match READSB_COMMIT"
log "building readsb commit $READSB_COMMIT as unprivileged readsb-build"
runuser -u readsb-build -- env HOME="$BUILD_ROOT" make -C "$SOURCE_DIR" RTLSDR=yes -j"$(nproc)"
# A hostile Makefile must not retain a writer or swap the output after the privilege boundary.
pkill -KILL -u readsb-build 2>/dev/null || true
chown -R root:root "$BUILD_ROOT"
chmod -R go-w "$BUILD_ROOT"
if [ ! -f "$SOURCE_DIR/readsb" ] || [ -L "$SOURCE_DIR/readsb" ]; then
  die "readsb build output must be a regular non-symlink file"
fi

log "== 4. install =="
systemctl stop readsb 2>/dev/null || true
install -o root -g root -m 0755 "$SOURCE_DIR/readsb" /usr/local/bin/readsb
runuser -u readsb-build -- /usr/local/bin/readsb --version 2>&1 | head -1 || true

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
[ ! -L /etc/default/readsb ] || die "/etc/default/readsb must not be a symlink"
[ ! -e /etc/default/readsb ] || [ -f /etc/default/readsb ] \
  || die "/etc/default/readsb must be a regular file"
if [ ! -f /etc/default/readsb ]; then
  install -o root -g root -m 0600 "$HERE/readsb.default" /etc/default/readsb
  log "wrote /etc/default/readsb"
else
  log "/etc/default/readsb already exists — leaving it untouched"
fi
chown root:root /etc/default/readsb
chmod 0600 /etc/default/readsb

systemctl daemon-reload
systemctl enable --now readsb
log "done: readsb is $(systemctl is-active readsb)"
