# Skytrace receiver agent

The receiver agent reads one readsb or dump1090 `aircraft.json` source and uploads bounded batches
to a Skytrace server. Each release archive contains a self-contained Go binary, so the receiver
does not need Node.js, npm or a container runtime.

## Requirements

- Linux on one of the released CPU architectures
- systemd when using the supplied service unit
- One local JSON file or loopback HTTP JSON URL
- HTTPS access to the Skytrace server, except for explicitly allowed LAN HTTP

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
`linux-armv7` archive. Download `SHA256SUMS` from the same GitHub Release and verify the archive:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

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

Set `SKYTRACE_SERVER_URL`, a receiver ID and the matching token from the server's
`SKYTRACE_RECEIVER_TOKENS`. Select exactly one source.

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

The server URL must use HTTPS unless it is loopback. For an intentional non-loopback LAN HTTP
server, set `SKYTRACE_ALLOW_INSECURE_SERVER=1`; the agent logs a warning. For a private certificate
authority, set `SKYTRACE_CA_FILE=/absolute/path/to/ca.pem` instead of disabling TLS validation.
The former `NODE_EXTRA_CA_CERTS` name remains a compatibility alias; if both names are set, they
must have the same value.

Optional metadata:

- `SKYTRACE_RECEIVER_NAME`: operator-facing receiver name
- `SKYTRACE_RECEIVER_PUBLIC_NAME`: name shown to viewers
- `SKYTRACE_RECEIVER_LAT` and `SKYTRACE_RECEIVER_LON`: receiver coordinates
- `SKYTRACE_INTERVAL_MS`: upload interval from `1000` to `60000`, default `3000`

Test one upload before installing the service:

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

The supplied service uses a dynamic user, a read-only system, a private temporary directory and
read-only access to `/run/readsb`. Ensure the selected JSON file and parent directories are readable
by the dynamic service user. If the source lives elsewhere, add the narrow corresponding
`ReadOnlyPaths` entry in a systemd override.

Inspect failures with:

```sh
sudo journalctl -u skytrace-agent -n 100 --no-pager
```

Startup errors identify invalid settings. Request failures report a bounded class such as timeout,
HTTP status or body-too-large without logging the token.

The removed legacy setting `SKYTRACE_RECEIVER_PUBLIC_POSITION` fails startup when it is still set.

## Upgrade or roll back

Stop the service, extract the desired architecture-specific archive over `/opt/skytrace`, and
restart it. The environment file stays in `/etc` and is not replaced:

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
