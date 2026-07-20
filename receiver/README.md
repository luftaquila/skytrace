# Skytrace receiver

The receiver decodes ADS-B locally and uploads it to the skytrace server.
Target hardware: **ODROID-C2** (Amlogic S905, 4× Cortex-A53, 2GB RAM, arm64,
wired Ethernet) running Armbian Debian minimal.

## Stack

```
RTL-SDR (RTL2832U + R820T)  →  readsb  →  skytrace agent  →  server
                               decoder    uploader (POST /api/ingest/readsb)
```

Systemd services on the board:

| Service | Role | Notes |
|---|---|---|
| `readsb` | ADS-B decoder | owns the SDR; writes `/run/readsb/aircraft.json` (+ `stats.json`) every 1s; serves beast on `localhost:30005` |
| `skytrace-agent` | uploader | reads the JSON, POSTs to the server every few seconds |

Contents here: `provision.sh` (one-shot board setup), `readsb/` (decoder
build + units, see its README), `skytrace-agent.service` (uploader unit).

## Fresh board setup

1. Flash Armbian (Debian minimal, arm64) for ODROID-C2 to an SD card.
2. Create `/etc/skytrace-agent.env` (never committed):

   ```sh
   SKYTRACE_SERVER_URL=https://sky.luftaquila.io
   SKYTRACE_RECEIVER_ID=<id registered in SKYTRACE_RECEIVER_TOKENS>
   SKYTRACE_TOKEN=<token>
   SKYTRACE_AIRCRAFT_FILE=/run/readsb/aircraft.json
   SKYTRACE_RECEIVER_NAME=<display name>
   SKYTRACE_INTERVAL_MS=5000
   ```

3. Run the provisioner as root:

   ```sh
   sudo bash receiver/provision.sh
   ```

   It builds and installs readsb from source (`readsb/install.sh`), blacklists
   the kernel DVB driver that would otherwise grab the dongle, installs node,
   clones this repo to `/opt/skytrace` for the agent (which has no npm
   dependencies), and enables both services.

## Aggregator feeds (optional)

- **ADS-B Exchange**: an extra `--net-connector` entry in `NET_OPTIONS` in
  `/etc/default/readsb` on the board. The feed UUID stays out of the repo.
- **FlightAware**: `piaware` in relay mode reads beast frames from readsb's
  `localhost:30005`. Install manually; reuse the existing `feeder-id` to keep
  the claimed site.

## Key paths

- readsb output: `/run/readsb/aircraft.json`, stats: `/run/readsb/stats.json`
- agent env: `/etc/skytrace-agent.env` (server URL, token — not committed)
- decoder opts: `/etc/default/readsb` (feed connectors live here on the board)
- services: `readsb`, `skytrace-agent`

## Troubleshooting

**Site shows 0 aircraft**

1. Server `/api/receivers/public` → the receiver's `online` / `lastSeenAt`:
   - `online:false` → board or agent is down; check the board and
     `systemctl status skytrace-agent`.
   - `online:true`, `currentAircraft:0` → check the decoder (next step) or
     genuinely quiet airspace.
2. On the board: `systemctl is-active readsb`, then read
   `last1min.local.samples_processed` in `/run/readsb/stats.json`:
   - `0` while readsb is active → the SDR stream is stuck →
     `systemctl restart readsb`.
   - `>0` but no aircraft → likely low traffic (e.g. late night), not a fault.
3. An unplugged antenna still yields samples (noise) with 0 messages; **0
   samples** means the stream stalled, not the antenna.
