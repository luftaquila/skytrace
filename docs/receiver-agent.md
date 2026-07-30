# Skytrace receiver agent

The agent reads local, readsb-compatible `aircraft.json` from tar1090, ultrafeeder, dump1090-fa or
readsb and sends it to Skytrace. Each archive contains one Go binary; the receiver host does not
need Node.js, npm or a container runtime.

## Requirements

- Linux on a supported CPU architecture
- systemd, if using the supplied service unit
- A readable local `aircraft.json` file or a credential-free loopback HTTP URL
- Access to Skytrace over HTTPS; loopback HTTP is allowed, and LAN HTTP requires explicit opt-in

## Select an archive

Choose the release archive matching `uname -m`:

| `uname -m` | Release target |
| --- | --- |
| `armv6l` | `linux-armv6` |
| `armv7l` | `linux-armv7` |
| `aarch64` or `arm64` | `linux-arm64` |
| `x86_64` or `amd64` | `linux-amd64` |
| `riscv64` | `linux-riscv64` |

A 64-bit-capable Raspberry Pi running a 32-bit operating system reports `armv7l` and must use the
`linux-armv7` archive.

## Install

Extract the matching release archive into `/opt/skytrace`:

```sh
sudo install -d /opt/skytrace
sudo tar -xzf "skytrace-agent-vX.Y.Z-linux-ARCH.tar.gz" \
  --strip-components=1 -C /opt/skytrace
sudo install -o root -g root -m 0600 \
  /opt/skytrace/receiver/skytrace-agent.env.example /etc/skytrace-agent.env
sudoedit /etc/skytrace-agent.env
```

Set the required connection and identity values:

- `SKYTRACE_SERVER_URL`: an absolute HTTP or HTTPS base URL without credentials; the agent appends
  `/api/ingest/readsb`
- `SKYTRACE_RECEIVER_ID`: an ID matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`
- `SKYTRACE_TOKEN`: the token assigned to this receiver in the server's
  `SKYTRACE_RECEIVER_TOKENS`

Select exactly one source. `SKYTRACE_AIRCRAFT_URL` accepts only credential-free loopback HTTP URLs.

Local file:

```text
SKYTRACE_AIRCRAFT_FILE=/run/readsb/aircraft.json
SKYTRACE_AIRCRAFT_URL=
```

Loopback URL:

```text
SKYTRACE_AIRCRAFT_FILE=
SKYTRACE_AIRCRAFT_URL=http://127.0.0.1/tar1090/data/aircraft.json
```

Use HTTPS for `SKYTRACE_SERVER_URL` unless Skytrace runs on loopback. For HTTP on a trusted LAN, set
`SKYTRACE_ALLOW_INSECURE_SERVER=1`. To use a private certificate authority, set
`SKYTRACE_CA_FILE=/absolute/path/to/ca.pem`. The systemd service must be able to read the
certificate and traverse its parent directories.

Optional metadata:

- `SKYTRACE_RECEIVER_NAME`: operator-facing receiver name
- `SKYTRACE_RECEIVER_PUBLIC_NAME`: name shown to viewers
- `SKYTRACE_RECEIVER_LAT`: receiver latitude from `-90` through `90`
- `SKYTRACE_RECEIVER_LON`: receiver longitude from `-180` through `180`
- `SKYTRACE_INTERVAL_MS`: upload interval from `1000` to `60000`, default `3000`

Run a test upload before installing the service:

```sh
set -a
. /etc/skytrace-agent.env
set +a
/opt/skytrace/bin/skytrace-agent --once
```

## systemd

```sh
sudo install -m 0644 /opt/skytrace/receiver/skytrace-agent.service \
  /etc/systemd/system/skytrace-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now skytrace-agent
sudo systemctl status skytrace-agent
```

The service runs as a dynamic user with a read-only filesystem, `PrivateTmp`, `ProtectHome=yes` and
read-only access to `/run/readsb`. The source file and its parent directories must be accessible to
an unprivileged user.

For another file location, create a dedicated directory under `/run` and add it to `ReadOnlyPaths`
in a systemd override. Do not use `/tmp`, `/home`, `/root` or `/run/user`; the service cannot see
those host paths.

Inspect failures with:

```sh
sudo journalctl -u skytrace-agent -n 100 --no-pager
```

Errors report invalid settings, timeouts, HTTP status codes and oversized responses. The token is
not logged.

## Upgrade or roll back

Stop the service, extract the selected archive into `/opt/skytrace`, and restart it. This does not
replace `/etc/skytrace-agent.env`:

```sh
sudo systemctl stop skytrace-agent
sudo tar -xzf "skytrace-agent-vX.Y.Z-linux-ARCH.tar.gz" \
  --strip-components=1 -C /opt/skytrace
sudo install -m 0644 /opt/skytrace/receiver/skytrace-agent.service \
  /etc/systemd/system/skytrace-agent.service
sudo systemctl daemon-reload
sudo systemctl start skytrace-agent
sudo systemctl status skytrace-agent
```
