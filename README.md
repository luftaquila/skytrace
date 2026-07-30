# Skytrace

Self-hosted 3D flight tracking for your ADS-B receiver.

## Features

- 3D view of live traffic, terrain and receiver coverage domes
- Aircraft details, graphs and flight history playback
- Airport and runway overlays

## Quick start

```sh
curl -fLo compose.yml https://raw.githubusercontent.com/luftaquila/skytrace/main/compose.yml
umask 077
printf 'SKYTRACE_RECEIVER_TOKENS={"roof-01":"%s"}\n' "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Use `podman compose` instead of `docker compose` if preferred, then open <http://127.0.0.1:3000>.
See [self-hosting](docs/self-hosting.md) for public access, backups and upgrades.

## Receiver agent

The receiver agent reads readsb-compatible `aircraft.json` from tar1090, ultrafeeder,
dump1090-fa and readsb. Linux builds are available for ARMv6, ARMv7, ARM64, AMD64 and RISC-V 64.
See the [setup guide](docs/receiver-agent.md).

## Development

Development requires Node.js 24 and Go 1.26.

```sh
npm ci
npm --prefix web ci
npm run dev
```

Run `npm --prefix web run dev` in another terminal. Install Chromium for Playwright with
`npx playwright install chromium`. On Linux, use
`npx playwright install --with-deps chromium`. Run all checks with `npm run check`.

## Documentation

- [Self-hosting and operations](docs/self-hosting.md)
- [Configuration](docs/configuration.md)
- [Receiver agent](docs/receiver-agent.md)

## Data sources

- [OurAirports](https://ourairports.com/): airports and runways
- Esri World Imagery: satellite imagery
- [Mapterhorn](https://mapterhorn.com/): terrain
- [OpenFreeMap](https://openfreemap.org/): boundaries and place labels
- Community ADS-B aggregator: optional area traffic
