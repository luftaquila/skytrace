# Skytrace self-hosting

The Skytrace server is distributed as an OCI image and runs with `compose.yml`. Docker and Podman
use the same Compose and `.env` files. For a tagged release, use the Compose file and image listed
in that release.

## Requirements

- Docker Engine with Docker Compose v2, or Podman with a Compose provider that supports profiles
- `curl` and OpenSSL
- A current browser with WebGL 2 support
- An available host port from `1024` through `65535` (default: `3000`)

Do not use `sudo` with a rootless engine. Use it consistently with a rootful engine. Rootless and
rootful engines have separate image and volume stores.

## Install

Choose a GitHub Release and use its tag for both the Compose file and image:

```sh
VERSION=vX.Y.Z
RECEIVER_ID=receiver-01
curl -fLo compose.yml \
  "https://raw.githubusercontent.com/luftaquila/skytrace/${VERSION}/compose.yml"
umask 077
TOKEN=$(openssl rand -hex 32)
printf '%s\n' \
  "SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:${VERSION}" \
  "SKYTRACE_RECEIVER_TOKENS={\"$RECEIVER_ID\":\"$TOKEN\"}" > .env
```

Replace `vX.Y.Z` with the release tag and set `RECEIVER_ID` to the ID you want to use for the
receiver. Do not mix Compose and image versions.

Docker:

```sh
docker compose --env-file .env config
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Podman:

```sh
podman compose --env-file .env config
podman compose --env-file .env pull
podman compose --env-file .env up -d
```

The remaining examples use `docker compose`. Replace it with `podman compose` for Podman.

Open `http://127.0.0.1:3000`. The health check passes after the SQLite schema is ready.

By default, Skytrace listens only on loopback. Set `SKYTRACE_BIND=0.0.0.0`, `::` or a specific
interface address only for a firewall-protected LAN. For multiple instances, use a different
Compose project name, port, `SKYTRACE_VOLUME` and `SKYTRACE_BACKUP_DIR` for each one.

## Public and private access

Traffic, history, KML, coverage and event-stream APIs are public by default. Receiver uploads
require bearer tokens. Add authentication at the reverse proxy for a private deployment.

When using a domain, serve Skytrace at the domain root, such as `https://sky.example.com/`.
Reverse-proxy subpaths such as `/skytrace/` are not supported.

Terminate TLS and enable HSTS at the reverse proxy or tunnel. Keep Skytrace on plain HTTP behind
it. Forwarding headers are ignored by default.

Set `SKYTRACE_TRUST_PROXY` to one or more proxy IP addresses or narrow CIDRs, separated by commas.
Use the address seen by the Skytrace container, which may be a Docker or Podman bridge address even
when the proxy connects to `127.0.0.1` on the host.

Configure the proxy to overwrite client-supplied `X-Forwarded-*` headers. Do not use a boolean or
hop count for `SKYTRACE_TRUST_PROXY`. A wrong value can break per-IP limits or allow spoofed client
addresses.

## Status and logs

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs -f skytrace
```

## Podman reboot persistence

Enable `podman-restart.service` to restart the containers after a reboot. For rootless Podman:

```sh
systemctl --user enable podman-restart.service
loginctl enable-linger "$USER"
```

If `enable-linger` needs administrator access, run `sudo loginctl enable-linger USER`. For rootful
Podman:

```sh
sudo systemctl enable podman-restart.service
```

## Backup

Create the backup directory first. Backups do not overwrite existing files. The command verifies
the archive and checks for `skytrace.db`.

```sh
install -d -m 0700 backups
docker compose --env-file .env stop skytrace
docker compose --env-file .env --profile ops run --rm \
  -e SKYTRACE_BACKUP_FILE="skytrace-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" backup
docker compose --env-file .env start skytrace
```

If the backup fails, restart `skytrace` before troubleshooting.

## Restore to a new volume

Never restore over the active volume. Stop Skytrace, copy `.env`, then choose an unused
`SKYTRACE_VOLUME`:

```sh
docker compose --env-file .env stop skytrace
cp -p .env .env.before-restore
# Edit SKYTRACE_VOLUME in .env, for example: skytrace-data-restored-20260729
docker compose --env-file .env --profile ops run --rm \
  -e SKYTRACE_RESTORE_FILE=skytrace-data-20260729T000000Z.tar.gz restore
docker compose --env-file .env up -d --force-recreate
```

The target volume must be empty. The restore rejects unsafe paths and removes partial files after a
failure. It does not remove the previous volume. To return to the old data, restore `.env` and
recreate the service:

```sh
cp -p .env.before-restore .env
docker compose --env-file .env up -d --force-recreate
```

## Upgrade and rollback

Back up first. Save the deployment files, then use the same release tag for the Compose file and
image. Keep receiver tokens and other local settings in `.env`:

```sh
NEW_VERSION=vX.Y.Z
cp -p .env .env.before-upgrade
cp -p compose.yml compose.yml.before-upgrade
curl -fLo compose.yml \
  "https://raw.githubusercontent.com/luftaquila/skytrace/${NEW_VERSION}/compose.yml"
# Set SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:${NEW_VERSION} in .env.
docker compose --env-file .env config
docker compose --env-file .env pull
docker compose --env-file .env up -d --force-recreate
```

For a rollback, download the previous release's Compose file and set `SKYTRACE_IMAGE` to the image
from that release:

```sh
PREVIOUS_VERSION=vX.Y.Z
curl -fLo compose.yml \
  "https://raw.githubusercontent.com/luftaquila/skytrace/${PREVIOUS_VERSION}/compose.yml"
# Set SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:${PREVIOUS_VERSION} in .env.
docker compose --env-file .env pull
docker compose --env-file .env up -d --force-recreate
```

The volume does not change during an upgrade or rollback. Check the release notes before upgrading;
an older image may not read a schema written by a newer one.

## Configuration

Compose loads `.env` for variable interpolation and the server environment. `compose.yml` sets the
internal port, database path, airfield data path and static file path. Do not override `PORT`,
`SKYTRACE_DB_PATH`, `SKYTRACE_AIRFIELDS_DIR` or `SKYTRACE_STATIC_DIR`.

### Deployment settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKYTRACE_IMAGE` | `ghcr.io/luftaquila/skytrace:latest` | server image; use a release tag to pin the version |
| `SKYTRACE_BIND` | `127.0.0.1` | IPv4 or IPv6 host bind address |
| `SKYTRACE_PORT` | `3000` | host port from `1024` through `65535` |
| `SKYTRACE_VOLUME` | `skytrace-data` | persistent named volume |
| `SKYTRACE_ENV_FILE` | `.env` | server environment file; relative paths resolve from the Compose file's directory |
| `SKYTRACE_BACKUP_DIR` | `./backups` | host directory mounted in the `ops` backup and restore services |

For multiple instances, use a different Compose project name, port, volume and backup directory
for each one.

The backup and restore commands accept `SKYTRACE_BACKUP_FILE` and `SKYTRACE_RESTORE_FILE`. Both are
relative to `SKYTRACE_BACKUP_DIR` and default to `skytrace-data.tar.gz`.

### Server settings

| Variable | Default | Accepted values |
| --- | --- | --- |
| `SKYTRACE_RECEIVER_TOKENS` | empty | JSON object mapping receiver IDs to unique tokens of at least 32 characters |
| `SKYTRACE_TRUST_PROXY` | `0` | `0` or an explicit comma-separated list of proxy IP/CIDR entries |
| `SKYTRACE_TRACK_RETENTION_DAYS` | `90` | integer `1` through `365` and at least `ceil(coverage window / 24) + 1` |
| `SKYTRACE_INGEST_BATCH_RETENTION_DAYS` | `7` | integer `1` through `90` |
| `SKYTRACE_CURRENT_WINDOW_SECONDS` | `90` | non-negative integer |
| `SKYTRACE_MAX_OBSERVATION_AGE_SECONDS` | `120` | non-negative integer |
| `SKYTRACE_TRACK_MIN_INTERVAL_SECONDS` | `3` | non-negative integer; `0` stores every accepted update |
| `SKYTRACE_POSITION_FILTER_MAX_MACH` | `3.5` | positive finite number |
| `SKYTRACE_LIVE_MAX_AIRCRAFT` | `5000` | integer `100` through `20000` |
| `SKYTRACE_LIVE_MAX_BYTES` | `8388608` | integer `65536` through `33554432` |
| `SKYTRACE_AREA_FEED_URL` | empty | optional credential-free URL template containing each of `{lat}`, `{lon}` and `{radius}` exactly once |
| `SKYTRACE_AREA_FEED_TTL_SECONDS` | `5` | non-negative integer |
| `SKYTRACE_AREA_FEED_MIN_UPSTREAM_MS` | `1100` | non-negative integer |
| `SKYTRACE_AIRFIELDS_REFRESH_SECONDS` | `604800` | non-negative integer |
| `SKYTRACE_AIRFIELDS_AIRPORTS_URL` | built-in | optional airports CSV source override |
| `SKYTRACE_AIRFIELDS_RUNWAYS_URL` | built-in | optional runways CSV source override |

Receiver IDs must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`. Tokens must be unique strings of at
least 32 characters. At startup, `SKYTRACE_RECEIVER_TOKENS` replaces the stored token list. Change
a value to rotate a token; remove an entry to revoke it. If the variable is unset or empty,
ingestion is disabled.

`SKYTRACE_AREA_FEED_URL` and the airfield source overrides require HTTPS without credentials.
Loopback HTTP is also allowed. Place the `SKYTRACE_AREA_FEED_URL` placeholders in the path or query,
not the host.

The default 720-hour coverage window needs at least 31 days of track retention. A shorter retention
period does not shrink the SQLite file immediately; SQLite reuses the freed pages.

### Coverage settings

| Variable | Default | Accepted values |
| --- | ---: | --- |
| `SKYTRACE_COVERAGE_WINDOW_HOURS` | `720` | integer `1` through `8760` |
| `SKYTRACE_COVERAGE_REFRESH_SECONDS` | `180` | non-negative integer |
| `SKYTRACE_COVERAGE_HORIZONTAL_STEP_NM` | `2` | positive finite number |
| `SKYTRACE_COVERAGE_VERTICAL_STEP_FT` | `800` | positive finite number |
| `SKYTRACE_COVERAGE_CELL_HORIZONTAL_STEP_NM` | half of horizontal step (`1`) | positive finite number |
| `SKYTRACE_COVERAGE_CELL_VERTICAL_STEP_FT` | half of vertical step (`400`) | positive finite number |
| `SKYTRACE_COVERAGE_AGGREGATION_CHUNK_SIZE` | `5000` | non-negative integer |
| `SKYTRACE_COVERAGE_HORIZONTAL_SUPPORT_NM` | `4.5` | positive finite number |
| `SKYTRACE_COVERAGE_VERTICAL_SUPPORT_FT` | `2500` | positive finite number |
| `SKYTRACE_COVERAGE_HORIZONTAL_INTERPOLATION_CELLS` | `2` | non-negative integer |
| `SKYTRACE_COVERAGE_HORIZONTAL_SMOOTHING_PASSES` | `2` | non-negative integer |
| `SKYTRACE_COVERAGE_VERTICAL_SMOOTHING_PASSES` | `4` | non-negative integer |
| `SKYTRACE_COVERAGE_SMOOTHING_ITERATIONS` | `5` | non-negative integer |
| `SKYTRACE_COVERAGE_MAX_CELLS` | `1200000` | non-negative integer |
| `SKYTRACE_COVERAGE_MAX_TRIANGLES` | `200000` | non-negative integer |

Startup rejects the removed `SKYTRACE_INGEST_TOKEN`, `SKYTRACE_INGEST_TOKENS`,
`SKYTRACE_MAX_TRACK_QUERY_POINTS` and `SKYTRACE_REQUIRE_HTTPS` settings.
