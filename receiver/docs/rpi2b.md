# Setting up a skytrace receiver on a Raspberry Pi 2B

Step-by-step guide to turn a Raspberry Pi 2 Model B into a skytrace ADS-B
receiver. The same steps work on any Raspberry Pi running Raspberry Pi OS; only
the image architecture and the Wi-Fi note differ (see the callouts).

## What you need

- **Raspberry Pi 2 Model B** (BCM2836/7, 4× Cortex-A7 **ARMv7 32-bit**, 1 GB
  RAM, 100 Mbit wired Ethernet). **No on-board Wi-Fi/Bluetooth** — for Wi-Fi you
  need a USB Wi-Fi dongle; otherwise use the wired port.
- microSD card (≥ 8 GB) and a card reader.
- **RTL-SDR** dongle and an ADS-B antenna.
- A network with DHCP + internet (the on-device build needs it).
- A **receiver id + token** registered on the skytrace server — see step 1.

> **Architecture:** the Pi 2B is ARMv7, so you must use the **32-bit** Raspberry
> Pi OS (`armhf`). The 64-bit image only boots on Pi 3 and newer. The 32-bit
> image runs on every Pi, so it's the safe choice.

## 1. Register the receiver on the server (admin)

Pick an id (e.g. `roof-03`), generate a token, add it to the server's token map,
and restart so the server picks it up:

```sh
TOKEN=$(openssl rand -hex 24)          # save it — it goes on the Pi too
kubectl -n skytrace get secret skytrace-secrets \
  -o go-template='{{index .data "SKYTRACE_RECEIVER_TOKENS" | base64decode}}'
# add "<id>":"<token>" to that JSON (keep the existing entries), then:
kubectl -n skytrace create secret generic skytrace-secrets \
  --from-literal='SKYTRACE_RECEIVER_TOKENS={...,"roof-03":"<token>"}' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n skytrace rollout restart deploy skytrace
```

## 2. Flash Raspberry Pi OS (with headless setup) — easiest path

Use **Raspberry Pi Imager** (<https://www.raspberrypi.com/software/>):

1. Choose OS → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (32-bit)**.
2. Choose your SD card.
3. Click the ⚙️ / *Edit Settings* and set:
   - **hostname** (e.g. `skytrace-roof03`)
   - **username + password**
   - **Wi-Fi** SSID + password + country (only used if a USB Wi-Fi dongle is
     present; harmless otherwise — Ethernet still works via DHCP)
   - **enable SSH** → *Allow public-key authentication only* and paste your key
   - locale / timezone
4. Write.

Imager bakes all of that into the image, so the Pi comes up on the network with
your user + SSH already working. This is the recommended path for most people.

> **Manual / fully-scripted alternative (no Imager):** direct-download Raspberry
> Pi OS images do **not** parse `custom.toml`; the customization hook is a
> `firstrun.sh` on the FAT boot partition referenced from `cmdline.txt`. If you
> script this yourself, write `firstrun.sh` (it may call the helpers in
> `/usr/lib/raspberrypi-sys-mods/imager_custom` — `set_hostname`, `enable_ssh`,
> `set_wlan`, `set_keymap`, `set_timezone` — and `/usr/lib/userconf-pi/userconf
> '<user>' '<sha512-hash>'` to create the first user) and append `systemd.run=
> /boot/firmware/firstrun.sh systemd.run_success_action=reboot
> systemd.unit=kernel-command-line.target` to `/boot/firmware/cmdline.txt` as a
> single line. The FAT boot partition mounts at `/boot/firmware`.

## 3. First boot + log in

Insert the card, connect **Ethernet (recommended for first boot) or a USB Wi-Fi
dongle**, and power on. First boot resizes the filesystem and applies your
settings, then reboots. Find the IP (router, or `ping <hostname>.local`) and:

```sh
ssh <youruser>@<pi-ip>
```

Optional niceties:

```sh
echo '<youruser> ALL=(ALL:ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010-$USER-nopasswd
sudo chmod 440 /etc/sudoers.d/010-$USER-nopasswd
mkdir -p ~/.ssh && curl -fsSL https://github.com/<you>.keys >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

> **No-RTC clock gotcha:** the Pi has no battery-backed clock, so at boot its
> time is the image's build date until NTP syncs (a minute or two after the
> network is up). If you run any HTTPS step too early you'll get *"certificate is
> not yet valid"* errors. Wait for the clock, e.g.:
> `sudo timedatectl set-ntp true; timedatectl` → *System clock synchronized: yes*.

## 4. Install the skytrace receiver software

Create the agent env with your id + token, then run the repo's provisioner. It
installs deps, **builds readsb from source on-device** (a few minutes on a Pi
2B), creates the `readsb` user, blacklists the kernel DVB driver, and enables the
`readsb` + `skytrace-agent` services.

```sh
# git is not preinstalled on Raspberry Pi OS Lite:
sudo apt-get update && sudo apt-get install -y git

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

git clone --depth 1 https://github.com/luftaquila/skytrace.git /tmp/skytrace
sudo bash /tmp/skytrace/receiver/provision.sh
```

## 5. Remote access with Tailscale (optional, recommended)

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=<hostname>
```

Follow the login URL to join your tailnet. Especially useful if the Pi is on a
guest Wi-Fi with client isolation, where you otherwise can't reach it.

## 6. Verify

```sh
systemctl is-active readsb skytrace-agent
python3 -c "import json;print(json.load(open('/run/readsb/stats.json'))['last1min']['local']['samples_processed'])"
```

Then check the server (appears once the agent uploads):

```
https://sky.luftaquila.io/api/receivers/public
```

Your id should show `online: true`. With the antenna connected in daytime you
should see aircraft within a minute or two.

## Gotchas

- **No on-board Wi-Fi** on the Pi 2B — use Ethernet or a USB Wi-Fi dongle. Most
  common Realtek/Ralink dongles work out of the box on Raspberry Pi OS.
- **No RTC** — wait for NTP before any HTTPS step (see step 3 callout).
- **`git` is not preinstalled** on Raspberry Pi OS Lite — install it before
  `git clone` (step 4).
- Use the **32-bit** image on a Pi 2B.
- **Attach the antenna** — an unplugged antenna yields samples (noise) but ~0
  messages.
