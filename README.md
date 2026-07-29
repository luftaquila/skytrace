# Skytrace

Self-hosted 3D ADS-B tracking for `linux/amd64` and `linux/arm64`, using readsb or
dump1090 data.

## Features

- Live 3D traffic, terrain, flight trails and per-receiver coverage
- Track playback, graphs, KML export and proximity alerts
- Airport and runway overlays, plus optional area traffic
- Mobile UI, multiple receiver agents and local SQLite storage

## Quick start

- Requirements: Docker Engine with Docker Compose v2, `curl`, OpenSSL and a current WebGL 2
  browser.
- Choose a [GitHub Release](https://github.com/luftaquila/skytrace/releases) containing
  `compose.yml`, `skytrace.env.example`, `self-hosting.md` and their checksums. No source checkout
  is required.
- Download and verify the release files:

  ```sh
  VERSION=vX.Y.Z
  BASE="https://github.com/luftaquila/skytrace/releases/download/${VERSION}"
  for ASSET in compose.yml skytrace.env.example self-hosting.md; do
    curl -fLo "$ASSET" "$BASE/$ASSET"
    curl -fLo "$ASSET.sha256" "$BASE/$ASSET.sha256"
    test "$(openssl dgst -sha256 "$ASSET" | awk '{print $NF}')" = \
      "$(cat "$ASSET.sha256")"
  done
  install -m 0600 skytrace.env.example .env
  openssl rand -hex 32
  ```

- Replace the token placeholder in `SKYTRACE_RECEIVER_TOKENS` with the generated token. Keep the
  release-provided `SKYTRACE_IMAGE` digest unchanged.
- Start Skytrace:

  ```sh
  docker compose --env-file .env config
  docker compose --env-file .env pull
  docker compose --env-file .env up -d
  ```

- Open <http://127.0.0.1:3000>. Check service health at
  <http://127.0.0.1:3000/healthz>.
- Podman uses the same files and arguments with `podman compose`. See the
  [self-hosting guide](docs/self-hosting.md) for rootless operation, public access, backup, restore
  and upgrades.

## Receiver agent

- Reads one local readsb or dump1090 `aircraft.json` source and uploads bounded batches to Skytrace.
- Requires Node.js 24 and the agent archive from the same release as the server.
- Configure the server URL, receiver ID, matching token and one JSON source.
- Installation and systemd setup: [receiver agent guide](docs/receiver-agent.md).

## Network access

- The default listener is `127.0.0.1:3000`. Expose it to a LAN only behind a firewall.
- For Internet access, keep the listener on loopback and terminate TLS at a same-host reverse proxy
  or tunnel.
- Read APIs are unauthenticated. Add reverse-proxy authentication for a private deployment.
- Serve Skytrace at the domain root. Reverse-proxy subpaths are unsupported.

## Development

- Requires Node.js 24.
- Install dependencies: `npm ci && npm --prefix web ci`.
- Install browser tests: `npx playwright install chromium`; on Linux, use
  `npx playwright install --with-deps chromium`.
- Start the backend: `npm run dev`.
- Start the UI in another terminal: `npm --prefix web run dev`.
- Override its default API with
  `SKYTRACE_DEV_API_TARGET=https://sky.example.com npm --prefix web run dev`.
- Run all checks: `npm run check`.

## Documentation

- [Self-hosting and operations](docs/self-hosting.md)
- [Configuration](docs/configuration.md)
- [Receiver agent](docs/receiver-agent.md)

## Data sources

- [OurAirports](https://ourairports.com/): airports and runways
- Esri World Imagery: satellite imagery
- [Mapterhorn](https://mapterhorn.com/): terrain
- [OpenFreeMap](https://openfreemap.org/): boundaries and place labels
- Operator-configured community ADS-B aggregator: optional area traffic
