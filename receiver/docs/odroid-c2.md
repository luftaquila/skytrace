# Setting up a skytrace receiver on an ODROID-C2

Step-by-step guide to turn a blank ODROID-C2 into a skytrace ADS-B receiver.
Nothing here is unique to one board — any Debian-based **arm64** SBC with wired
Ethernet works the same way; only the flashing image differs.

## What you need

- **ODROID-C2** (Amlogic S905, 4× Cortex-A53 arm64, 2 GB RAM, wired Gigabit
  Ethernet — no on-board Wi-Fi). Runs mainline kernels, so it stays supported
  even though the hardware is discontinued.
- microSD card (≥ 8 GB) and a card reader on your workstation.
- **RTL-SDR** dongle (RTL2832U + R820T) and an ADS-B antenna.
- A wired network with DHCP and internet (the on-device build needs it).
- A **receiver id + token** registered on the skytrace server — see step 1.
- Tools on your workstation: `xz`, `dd`. To edit the image's root filesystem
  offline you need ext4 access: on Linux just mount it; on macOS install
  `e2fsprogs` (`brew install e2fsprogs`, gives `debugfs`).

## 1. Register the receiver on the server (admin)

Each receiver authenticates with its own token. Pick an id (e.g. `roof-02`) and
generate a token, then add it to the server's token map and restart:

```sh
TOKEN=$(openssl rand -hex 24)          # save this — it goes on the board too
echo "$TOKEN"

# merge {"<id>":"<token>"} into the existing SKYTRACE_RECEIVER_TOKENS JSON,
# keeping every receiver already there, then apply + restart:
kubectl -n skytrace get secret skytrace-secrets \
  -o go-template='{{index .data "SKYTRACE_RECEIVER_TOKENS" | base64decode}}'
# edit the JSON to add your id:token, then:
kubectl -n skytrace create secret generic skytrace-secrets \
  --from-literal='SKYTRACE_RECEIVER_TOKENS={...,"roof-02":"<token>"}' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n skytrace rollout restart deploy skytrace
```

The server reads the token map at startup and hashes it into its DB, so the
restart is required before the new receiver can upload.

## 2. Flash Armbian

Download the current **Armbian Debian minimal (arm64)** image for the
ODROID-C2 from <https://www.armbian.com/odroid-c2/> and verify its checksum.
Then write it to the card (replace `diskN`/`sdX` with your device — double-check
it, `dd` is unforgiving):

```sh
# macOS
diskutil unmountDisk /dev/diskN
xz -dc Armbian_*_Odroidc2_*.img.xz | sudo dd of=/dev/rdiskN bs=4m

# Linux
xz -dc Armbian_*_Odroidc2_*.img.xz | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
```

The Armbian image is a single ext4 root partition (no separate FAT boot
partition).

## 3. First-boot setup

The C2 is usually run headless. Two options:

**A. Interactive (HDMI + keyboard, or serial console).** Boot the board; Armbian
walks you through root password, a new user, locale, and network on first login.

**B. Headless preset (no monitor).** Before first boot, drop Armbian's autoconfig
file at `/root/.not_logged_in_yet` on the root partition. Mount the ext4 root
(Linux: `sudo mount /dev/sdX1 /mnt`; macOS: use `debugfs -w`) and write:

```ini
PRESET_NET_CHANGE_DEFAULTS="1"
PRESET_NET_ETHERNET_ENABLED="1"
PRESET_NET_USE_STATIC="0"
PRESET_LOCALE="en_US.UTF-8"
PRESET_TIMEZONE="Asia/Seoul"
PRESET_ROOT_PASSWORD="<choose-one>"
PRESET_USER_NAME="<youruser>"
PRESET_USER_PASSWORD="<choose-one>"
```

Armbian applies these on first boot. To run extra setup automatically, also drop
a `/root/provisioning.sh` — Armbian sources it once after the first login.

Either way, the board comes up on Ethernet via DHCP.

## 4. Log in and configure identity (optional niceties)

SSH to the board (find its IP from your router or `ping <hostname>.local`):

```sh
ssh <youruser>@<board-ip>
sudo hostnamectl set-hostname <hostname>          # e.g. skytrace-roof02
# passwordless sudo (optional):
echo '<youruser> ALL=(ALL:ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010-$USER-nopasswd
sudo chmod 440 /etc/sudoers.d/010-$USER-nopasswd
# pull your SSH keys (optional):
mkdir -p ~/.ssh && curl -fsSL https://github.com/<you>.keys >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## 5. Install the skytrace receiver software

Create the agent env with the id + token from step 1, then run the repo's
provisioner. It installs build/runtime deps, **builds readsb from source
on-device** (the C2 does this in ~1–2 min), creates the unprivileged `readsb`
user, blacklists the kernel DVB driver, installs `readsb` + `skytrace-agent`
services, and enables both.

```sh
sudo tee /etc/skytrace-agent.env >/dev/null <<'ENV'
SKYTRACE_SERVER_URL=https://sky.luftaquila.io
SKYTRACE_RECEIVER_ID=<your-id>
SKYTRACE_TOKEN=<your-token>
SKYTRACE_AIRCRAFT_FILE=/run/readsb/aircraft.json
SKYTRACE_RECEIVER_NAME=<display-name>
SKYTRACE_RECEIVER_PUBLIC_POSITION=false
SKYTRACE_INTERVAL_MS=3000
ENV
sudo chmod 600 /etc/skytrace-agent.env

sudo apt-get update && sudo apt-get install -y git
git clone --depth 1 https://github.com/luftaquila/skytrace.git /tmp/skytrace
sudo bash /tmp/skytrace/receiver/provision.sh
```

Range is unlimited by design (no receiver location / no `--max-range`). Beast
output is served on `localhost:30005` for optional aggregator relays. See
`receiver/readsb/readsb.default` for the decoder options.

## 6. Remote access with Tailscale (optional, recommended)

The board is DHCP and may move networks, so a stable address helps:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=<hostname>
```

Follow the printed login URL to join your tailnet. After that the board is
reachable at its tailscale IP regardless of the local network.

## 7. Aggregator feeds (optional)

- **ADS-B Exchange** — no extra daemon: add a `--net-connector
  feed1.adsbexchange.com,30004,beast_reduce_plus_out,uuid=<your-uuid>` entry to
  `NET_OPTIONS` in `/etc/default/readsb` (use `beast_reduce_plus_out` — plain
  `beast_reduce_out` never sends the uuid), then `sudo systemctl restart readsb`.
  Also install `adsbexchange-stats` for the stats page (point its `JSON_PATHS`
  at `/run/readsb`).
- **FlightAware** — install `piaware` in relay mode reading readsb's beast on
  `127.0.0.1:30005`. No prebuilt arm64 package for recent Debian; build it with
  <https://github.com/flightaware/piaware_builder> (`sensible-build.sh trixie`).

## 8. Verify

```sh
systemctl is-active readsb skytrace-agent
# decoder is reading the SDR (nonzero even with the antenna off, from noise):
python3 -c "import json;print(json.load(open('/run/readsb/stats.json'))['last1min']['local']['samples_processed'])"
```

Then check the server sees it (appears once the agent uploads):

```
https://sky.luftaquila.io/api/receivers/public
```

Your id should show `online: true`. `currentAircraft: 0` with the antenna
connected in daytime usually means an antenna/coax problem — 0 **samples** means
the SDR stream stalled (restart `readsb`); nonzero samples but 0 messages means
no signal reaching the dongle.

## Gotchas

- **Attach the antenna** before expecting aircraft. An unplugged antenna still
  yields samples (noise) but ~0 messages.
- **`dd` to the wrong disk wipes it.** Re-check the device node every time.
- After editing an ext4 image offline with `debugfs`, run `e2fsck -fn` on the
  partition before booting.
- The C2 has no Wi-Fi; use the wired port (or a USB Ethernet/Wi-Fi adapter).
