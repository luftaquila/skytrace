# Skytrace self-hosting

Skytrace uses one deployment contract for Docker and Podman: `compose.yml`, `.env` and the OCI
image named by that environment file. The default image tag is `latest`; each GitHub Release body
provides its versioned image setting. There is no server launcher or server archive.

## Requirements

- Docker Engine with Docker Compose v2, or Podman with a Compose provider that supports profiles
- `curl` and OpenSSL
- A current browser with WebGL 2
- Host port `1024` through `65535`; the release default is `3000`
- A domain-root URL such as `https://sky.example.com/`; reverse-proxy subpaths such as
  `/skytrace/` are not supported

Run rootless engines without `sudo`. For rootful operation, use `sudo` consistently when required.
The two modes have separate image and volume stores, but use the same Compose and environment files.

## Install

Download the current Compose file and create `.env`:

```sh
curl -fLo compose.yml \
  https://raw.githubusercontent.com/luftaquila/skytrace/main/compose.yml
umask 077
TOKEN=$(openssl rand -hex 32)
printf '%s\n' \
  'SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:latest' \
  "SKYTRACE_RECEIVER_TOKENS={\"roof-01\":\"$TOKEN\"}" > .env
```

To pin one version, replace the `SKYTRACE_IMAGE` line with the value in that GitHub Release body.

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

Open `http://127.0.0.1:3000`. The Compose health check reports success only after the required
SQLite schema is readable.

The default bind is loopback. Set `SKYTRACE_BIND=0.0.0.0`, `::` or a specific interface address
only for an intentional LAN listener protected by a firewall. Each additional installation needs
a unique Compose project name, port and `SKYTRACE_VOLUME`.

## Public and private access

The traffic, history, KML, coverage and event-stream read APIs are intentionally unauthenticated.
Receiver ingestion requires its configured bearer token. Put authentication in the reverse proxy
when the deployment must be private.

Terminate TLS and set HSTS in the external reverse proxy or tunnel. Skytrace itself stays on plain
HTTP behind that boundary and does not trust forwarding headers by default.

Set `SKYTRACE_TRUST_PROXY` only to the proxy addresses that may supply forwarding headers. For a
host proxy connecting over loopback:

```text
SKYTRACE_TRUST_PROXY=127.0.0.1/32,::1/128
```

For a containerized proxy, use its exact address or narrow network CIDR. Do not use a boolean or a
hop count. A wrong value makes all proxied viewers share the proxy address and can exhaust per-IP
request and event-stream limits.

## Status and logs

Docker:

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs -f skytrace
```

Podman uses the same arguments with `podman compose`.

## Podman reboot persistence

Podman's restart policy needs `podman-restart.service` to start eligible containers after a host
reboot. For rootless Podman, enable the user service and keep that user's systemd manager alive:

```sh
systemctl --user enable podman-restart.service
loginctl enable-linger "$USER"
```

If enabling linger is not permitted, an administrator can run
`sudo loginctl enable-linger USER`. For rootful Podman, enable the system service instead:

```sh
sudo systemctl enable podman-restart.service
```

## Backup

Create the host backup directory first. The backup service refuses to overwrite an existing
archive and verifies the complete gzip-compressed tar plus `skytrace.db`.

```sh
install -d -m 0700 backups
docker compose --env-file .env stop skytrace
docker compose --env-file .env --profile ops run --rm \
  -e SKYTRACE_BACKUP_FILE="skytrace-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" backup
docker compose --env-file .env start skytrace
```

If the backup command fails, start `skytrace` explicitly before troubleshooting. Podman uses the
same arguments with `podman compose`.

## Restore to a new volume

Never restore over the active volume. Stop Skytrace, preserve the current `.env`, then set a new
unused `SKYTRACE_VOLUME` value:

```sh
docker compose --env-file .env stop skytrace
cp -p .env .env.before-restore
# Edit SKYTRACE_VOLUME in .env, for example: skytrace-data-restored-20260729
docker compose --env-file .env --profile ops run --rm \
  -e SKYTRACE_RESTORE_FILE=skytrace-data-20260729T000000Z.tar.gz restore
docker compose --env-file .env up -d
```

The restore service requires an empty target volume, rejects unsafe archive paths and removes
partially extracted files when it fails. It never removes the previous volume. To return to the
old data, restore `.env.before-restore` and run `compose up -d` again.

## Upgrade and rollback

Back up first, save the deployment files, download the current Compose file and pull `latest`.
Keep the receiver tokens and other local settings in `.env`:

```sh
cp -p .env .env.before-upgrade
cp -p compose.yml compose.yml.before-upgrade
curl -fLo compose.yml \
  https://raw.githubusercontent.com/luftaquila/skytrace/main/compose.yml
# Keep SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:latest in .env.
docker compose --env-file .env config
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Compose does not provide automatic rollback. If startup fails, select the previous GitHub Release,
download its Compose file, and set `.env` to the version shown in that release body:

```sh
VERSION=vX.Y.Z
curl -fLo compose.yml \
  "https://raw.githubusercontent.com/luftaquila/skytrace/${VERSION}/compose.yml"
# Set SKYTRACE_IMAGE=ghcr.io/luftaquila/skytrace:${VERSION} in .env.
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Both versions use the selected named volume. Read release notes before any schema-changing upgrade;
an old image may not understand a schema already changed by a newer image.

## Configuration

See `docs/configuration.md`. Coverage resolution and retention settings can materially change CPU,
memory and disk use.
