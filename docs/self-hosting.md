# Skytrace self-hosting

Skytrace uses one deployment contract for Docker and Podman: `compose.yml`, `.env` and the
digest-pinned OCI image named by that environment file. There is no server launcher or server
archive.

## Requirements

- Docker Engine with Docker Compose v2, or Podman with a Compose provider that supports profiles
- `curl`, OpenSSL and `tar`
- A current browser with WebGL 2
- Host port `1024` through `65535`; the release default is `3000`
- A domain-root URL such as `https://sky.example.com/`; reverse-proxy subpaths such as
  `/skytrace/` are not supported

Use rootless Docker or Podman without `sudo`. Use a rootful engine consistently with `sudo`.
Rootful and rootless engines have separate image and volume stores, but use the same Compose and
environment files.

## Install

Download the direct release assets. They are not wrapped in a server tar:

```sh
VERSION=vX.Y.Z
BASE="https://github.com/luftaquila/skytrace/releases/download/${VERSION}"
curl -fLo compose.yml "$BASE/compose.yml"
curl -fLo skytrace.env.example "$BASE/skytrace.env.example"
curl -fLo self-hosting.md "$BASE/self-hosting.md"
curl -fLo compose.yml.sha256 "$BASE/compose.yml.sha256"
curl -fLo skytrace.env.example.sha256 "$BASE/skytrace.env.example.sha256"
curl -fLo self-hosting.md.sha256 "$BASE/self-hosting.md.sha256"
test "$(openssl dgst -sha256 compose.yml | awk '{print $NF}')" = "$(cat compose.yml.sha256)"
test "$(openssl dgst -sha256 skytrace.env.example | awk '{print $NF}')" = \
  "$(cat skytrace.env.example.sha256)"
test "$(openssl dgst -sha256 self-hosting.md | awk '{print $NF}')" = \
  "$(cat self-hosting.md.sha256)"
install -m 0600 skytrace.env.example .env
openssl rand -hex 32
```

Replace the receiver-token placeholder in `.env`. Keep the release-provided `SKYTRACE_IMAGE`
digest unchanged.

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

Back up first, save the old deployment files and download the new release assets into a separate
staging directory. After verifying their checksums, install the new Compose file and create the new
`.env` from that release's environment example. Copy local settings such as receiver tokens from
the previous `.env`, but do not copy its old `SKYTRACE_IMAGE`:

```sh
cp -p .env .env.before-upgrade
cp -p compose.yml compose.yml.before-upgrade
# Replace these paths with the verified files in the new release staging directory.
install -m 0644 /path/to/new/compose.yml compose.yml
install -m 0600 /path/to/new/skytrace.env.example .env.next
# Edit .env.next: copy local settings from .env.before-upgrade, retaining its new SKYTRACE_IMAGE.
mv .env.next .env
docker compose --env-file .env config
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Compose does not provide automatic rollback. If startup fails, restore both files from the
previous release and run the same command:

```sh
cp -p .env.before-upgrade .env
cp -p compose.yml.before-upgrade compose.yml
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Both versions use the selected named volume. Read release notes before any schema-changing upgrade;
an old image may not understand a schema already changed by a newer image.

## Configuration

See `docs/configuration.md` in the tagged source and the release asset `self-hosting.md`. Coverage
resolution and retention settings can materially change CPU, memory and disk use.
