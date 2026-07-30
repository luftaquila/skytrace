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
curl -fLo compose.yml \
  "https://raw.githubusercontent.com/luftaquila/skytrace/${VERSION}/compose.yml"
umask 077
TOKEN=$(openssl rand -hex 32)
printf '%s\n' \
  "SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:${VERSION}" \
  "SKYTRACE_RECEIVER_TOKENS={\"roof-01\":\"$TOKEN\"}" > .env
```

Replace `vX.Y.Z` with the release tag. Do not mix Compose and image versions.

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

See [configuration](configuration.md). Coverage resolution and retention affect CPU, memory and
disk use.
