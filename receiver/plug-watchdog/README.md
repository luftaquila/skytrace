# External plug watchdog

A **last-resort backstop** that power-cycles the Orange Pi i96 through its
Tasmota smart plug when the board is unreachable. It runs on an **always-on
machine that shares the board's LAN** (e.g. a Mac), **not** on the board.

## Why this is separate from the on-board watchdog

The board's own `wifi-watchdog` (see `../wifi-watchdog/`) recovers most outages
by rebooting. But the i96 WiFi chip (RDA5991 over SDIO) periodically wedges at
the **firmware** level, and a warm reboot **does not cut power to the WiFi
chip** — so a true firmware wedge *survives the reboot*.

Measured 2026-07-16 during a bad spell:

| Action | Result |
|---|---|
| board-internal `reboot -f` (manual) | no recovery |
| board-internal watchdog auto `reboot -f` | no recovery |
| **cold power-cycle via the plug** | **back in ~58s** (WiFi re-associated, readsb decoding) |

So the on-board watchdog **cannot** recover a bad spell on its own — only
removing power resets the WiFi chip. This external watchdog is that backstop,
triggered from a vantage point the wedge cannot take down.

```
[always-on machine]  --ping/https-->  [i96 board]        (detect: is it reachable?)
        |                                                  
        '----------HTTP------------->  [Tasmota plug] ---power---> [i96 board]
                                        (act: Off -> wait -> On)
```

## How it decides to act (conservative — a power-cycle is an unclean SD shutdown)

- **Gate:** the plug must be reachable. If it isn't, the LAN or plug is down,
  our view is untrustworthy, and we couldn't act anyway → **skip** (never
  power-cycle blind).
- The board is considered **UP** if **any** of these succeed:
  1. ICMP to its **tailscale IP** (stable across the board's LAN-IP flip-flops),
  2. ICMP to its **LAN IP**,
  3. the **server** reports the receiver `online` with a fresh `lastSeenAt`.
  Requiring **all three** to fail before acting makes a false-positive
  power-cycle very unlikely, while a real WiFi wedge fails all three.
- Unreachable for a sustained **`DOWN_SECS`** (default 180s) → **cold
  power-cycle**. The 180s deliberately gives the on-board warm-reboot watchdog
  time to try (and, for a firmware wedge, fail) first.

### Safety rails

- **`COOLDOWN`** (180s) after each cycle lets the ~58s cold boot finish before
  the board is judged "down" again.
- **`CYCLE_CAP`** (4) consecutive cycles with no recovery → a long **`BACKOFF`**
  (900s) plus a `CRITICAL` log line. If power-cycling 4× didn't help it isn't a
  WiFi wedge (dead board / PSU / plug); hammering only wears the SD card and a
  human is needed.

## Config (no addresses are committed)

All config is read from the environment. **Required:** `PLUG_URL` and at least
one of `BOARD_TS` / `BOARD_LAN`. **Optional:** `SERVER_URL` + `RECEIVER_NAME`
(adds the server-online signal). Tunables: `POLL`, `DOWN_SECS`, `OFF_SECS`,
`COOLDOWN`, `STALE`, `CYCLE_CAP`, `BACKOFF`, `PING_WAIT`, `DRY_RUN`.

`DRY_RUN=1` runs the full detection loop but only **logs** the power-cycle
intent — use it to watch behaviour without ever toggling power.

## Install (macOS / launchd)

```sh
# 1. install the script to a stable path
mkdir -p ~/.config/skytrace
cp receiver/plug-watchdog/skytrace-plug-watchdog.sh ~/.config/skytrace/
chmod +x ~/.config/skytrace/skytrace-plug-watchdog.sh

# 2. create the launchd agent from the example, fill in real values
cp receiver/plug-watchdog/io.luftaquila.skytrace-plug-watchdog.plist.example \
   ~/Library/LaunchAgents/io.luftaquila.skytrace-plug-watchdog.plist
#   edit it: replace __HOME__, __PLUG_IP__, __BOARD_TAILSCALE_IP__,
#   __BOARD_LAN_IP__, __SERVER_HOST__, __RECEIVER_NAME__

# 3. load it (RunAtLoad + KeepAlive: starts at login, restarts if it dies)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.luftaquila.skytrace-plug-watchdog.plist
launchctl list | grep skytrace           # PID + last exit status
```

Update / reload after editing:

```sh
launchctl bootout gui/$(id -u)/io.luftaquila.skytrace-plug-watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.luftaquila.skytrace-plug-watchdog.plist
```

## Logs

- `~/Library/Logs/skytrace-plug-watchdog.log` — the watchdog's own event log
  (started / plug reachable / board unreachable xN / POWER-CYCLE / recovered /
  CRITICAL backoff).
- `~/Library/Logs/skytrace-plug-watchdog.{out,err}.log` — launchd stdout/stderr.

## Limitations

- The plug and the watchdog machine must stay powered and on the board's LAN.
  If either is down, there is no automatic recovery (that's the `CRITICAL`
  backoff case — it needs a human).
- A power-cycle is an **ungraceful** shutdown for the board (kills readsb, SD
  card gets an unclean unmount). That's acceptable for a hung board but is why
  the thresholds are conservative and cycles are capped.
