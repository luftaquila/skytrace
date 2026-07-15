# Skytrace receiver

The receiver decodes ADS-B locally and uploads it to the skytrace server. This
directory holds the on-board pieces plus an operations runbook for the quirky
hardware it runs on.

## Stack

```
RTL-SDR (RTL2832U + R820T)  →  readsb  →  skytrace agent  →  server
                               decoder    uploader (POST /api/ingest/readsb)
```

Systemd services on the board:

| Service | Role | Notes |
|---|---|---|
| `readsb` | ADS-B decoder | writes `/run/readsb/aircraft.json` (+ `stats.json`) every 1s |
| `skytrace-agent` | uploader | reads the JSON, POSTs to the server every few seconds |
| `skytrace-wifi-watchdog` | self-heal | recovers the two failure modes below, unattended |

Contents here: `readsb/` (cross-build + deploy, see its README), `wifi-watchdog/`
(the watchdog), `skytrace-agent.service` (uploader unit).

## Hardware notes (Orange Pi i96 / RDA8810)

This board is inexpensive and has chronic quirks that dominate operations:

1. **WiFi wedges (RDA5991 / `rdawfmac` over SDIO).** The firmware's SDIO control
   channel periodically stops responding — `dmesg`:
   `wland_sdio_bus_rxctl: resumed on timeout` / `query_dcmd failed`. The board is
   still alive locally but passes no network data (total blackout). RF signal is
   fine; it's a firmware/SDIO hang. **No clean software fix** — the driver exposes
   no tunables and the firmware is closed. WiFi power-save and BT-coexistence are
   already disabled (via `rc.local`) and do **not** prevent it.
2. **RTL-SDR USB is marginal (`musb-hdrc` controller).** Two sub-modes:
   - **(2a) VBUS brownout storm** — the dongle repeatedly disconnects/re-enumerates
     (`dmesg`: `VBUS_ERROR`, ever-climbing `device number`). readsb can't hold the
     device. **Only a full power-cycle clears this — a soft reboot does not.** It is
     usually triggered/sustained by a readsb crash-restart loop resetting the device.
   - **(2b) sample-stream stall** — the SDR stream dies mid-run (`dmesg`:
     `Lost N packets on USB`); readsb stays "active" but reads 0 samples.
3. **Clock resets on boot.** No working RTC battery: the clock comes up in the past
   and NTP steps it forward. readsb may log `system clock jumped` during that
   correction — harmless once NTP settles; give it a minute after boot.

Because of (1) and (2), periodic outages are expected. The watchdog recovers them.

## Failure modes & self-healing

`wifi-watchdog/skytrace-wifi-watchdog.sh` runs on the board and handles two
**independent** failures. Actions are logged to
`/var/log/skytrace-wifi-watchdog.log` (persists across reboots).

| Mode | What you see | Signature | Auto-recovery |
|---|---|---|---|
| **A. WiFi blackout** | board unreachable; server stops receiving (receiver goes `online:false`) | WAN unreachable, **sustained** (gateway pings flap even when healthy → ignored as noise) | reload the WiFi module (firmware re-init, no reboot); **reboot** as a backstop if that fails, rate-limited |
| **B. readsb SDR stall** | site shows **0 aircraft** but board is online & `readsb` is "active" | `samples_processed` frozen at 0 while readsb active; `messages` counter frozen | **restart `readsb`** to re-open the dongle (no reboot) |

Mode B is invisible to Mode A's WAN check (the board stays online), so it's
detected separately via readsb's `samples_processed` — a **traffic-independent**
signal (message count would false-negative during quiet hours).

## Last-resort backstop: network smart plug

The board is powered through a **Tasmota smart plug** (its address is configured
out-of-band and intentionally not committed). When even the watchdog's reboot
can't recover a true hang, power-cycle the board:

```sh
curl "http://<plug>/cm?cmnd=Power%20Off"   # cut power
curl "http://<plug>/cm?cmnd=Power%20On"    # restore
curl "http://<plug>/cm?cmnd=Power"         # query state only (no toggle)
```

A full power-cycle (unlike a soft reboot) also clears the VBUS/USB
re-enumeration storm (2a). Power Off is ungraceful (kills readsb + unclean SD
shutdown) — use it for a hung board, not casually.

## Troubleshooting runbook

**Site shows 0 aircraft**
1. Server `/api/receivers/public` → the receiver's `online` / `lastSeenAt`:
   - `online:false` → **Mode A** (WiFi blackout). Watchdog should recover within
     ~1 min; if not, power-cycle via the plug.
   - `online:true`, `currentAircraft:0` → **Mode B** or genuinely quiet airspace.
2. On the board: `systemctl is-active readsb`, then read
   `last1min.local.samples_processed` in `/run/readsb/stats.json`:
   - `0` while readsb active → **Mode B** → `systemctl restart readsb` (the
     watchdog does this automatically).
   - `>0` but no aircraft → likely low traffic (e.g. late night), not a fault.
3. An unplugged antenna still yields samples (noise) with 0 messages; **0 samples**
   means the stream stalled (Mode B), not the antenna.

**Board unreachable**
- Mode A blackout — check the watchdog log after recovery.
- `dmesg` shows `VBUS_ERROR` + climbing `device number` → USB re-enumeration storm
  (2a) → **full power-cycle** (soft reboot won't clear it).

**readsb crash-loops / won't stay up**
- Usually the USB re-enumeration storm. Full power-cycle brings up a clean device;
  readsb then runs stably (0 restarts).

## Key paths

- readsb output: `/run/readsb/aircraft.json`, stats: `/run/readsb/stats.json`
- agent env: `/etc/skytrace-agent.env` (aircraft-json path, server URL, token — not committed)
- watchdog log: `/var/log/skytrace-wifi-watchdog.log`
- services: `readsb`, `skytrace-agent`, `skytrace-wifi-watchdog`
