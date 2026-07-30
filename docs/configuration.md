# Skytrace configuration

By default, Compose uses `.env` for both interpolation and the server container environment.
The release controls the internal container port, database path and static-asset path; do not
override `PORT`, `SKYTRACE_DB_PATH`, `SKYTRACE_AIRFIELDS_DIR` or `SKYTRACE_STATIC_DIR`.

## Deployment settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKYTRACE_IMAGE` | `ghcr.io/luftaquila/skytrace:latest` | OCI image; use a release body's version tag to pin it |
| `SKYTRACE_BIND` | `127.0.0.1` | IPv4 or IPv6 host bind address |
| `SKYTRACE_PORT` | `3000` | host port; use `1024` through `65535` for the shared rootless/rootful contract |
| `SKYTRACE_VOLUME` | `skytrace-data` | persistent named volume |
| `SKYTRACE_ENV_FILE` | `.env` | server environment file; relative paths resolve from the Compose file |
| `SKYTRACE_BACKUP_DIR` | `./backups` | host directory mounted by the `ops` backup and restore services |

Use a unique Compose project name, port, volume and backup directory for every additional instance.

The `ops` services also accept `SKYTRACE_BACKUP_FILE` and `SKYTRACE_RESTORE_FILE`; both default to
`skytrace-data.tar.gz` inside `SKYTRACE_BACKUP_DIR`. Set them on the individual backup or restore
command as shown in the self-hosting guide.

## Server settings

| Variable | Default | Current contract |
| --- | --- | --- |
| `SKYTRACE_RECEIVER_TOKENS` | empty | JSON object mapping receiver IDs to unique tokens of at least 32 characters |
| `SKYTRACE_TRUST_PROXY` | `0` | `0` or comma-separated explicit proxy IP/CIDR entries |
| `SKYTRACE_TRACK_RETENTION_DAYS` | `90` | integer `1` through `365`, and at least `ceil(coverage window / 24) + 1` |
| `SKYTRACE_INGEST_BATCH_RETENTION_DAYS` | `7` | integer `1` through `90` |
| `SKYTRACE_CURRENT_WINDOW_SECONDS` | `90` | non-negative integer |
| `SKYTRACE_MAX_OBSERVATION_AGE_SECONDS` | `120` | non-negative integer |
| `SKYTRACE_TRACK_MIN_INTERVAL_SECONDS` | `3` | non-negative integer; `0` stores every accepted update |
| `SKYTRACE_POSITION_FILTER_MAX_MACH` | `3.5` | positive finite number |
| `SKYTRACE_LIVE_MAX_AIRCRAFT` | `5000` | integer `100` through `20000` |
| `SKYTRACE_LIVE_MAX_BYTES` | `8388608` | integer `65536` through `33554432` |
| `SKYTRACE_AREA_FEED_URL` | empty | optional credential-free URL template containing `{lat}`, `{lon}` and `{radius}` once each |
| `SKYTRACE_AREA_FEED_TTL_SECONDS` | `5` | non-negative integer |
| `SKYTRACE_AREA_FEED_MIN_UPSTREAM_MS` | `1100` | non-negative integer |
| `SKYTRACE_AIRFIELDS_REFRESH_SECONDS` | `604800` | non-negative integer |
| `SKYTRACE_AIRFIELDS_AIRPORTS_URL` | built-in | optional airports CSV source override |
| `SKYTRACE_AIRFIELDS_RUNWAYS_URL` | built-in | optional runways CSV source override |

Receiver IDs must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`. Tokens must be unique strings of at
least 32 characters. `SKYTRACE_RECEIVER_TOKENS` is authoritative at startup: changing or removing
an entry rotates or revokes that receiver's stored token. An unset or empty map disables ingest.

Area-feed and airfield source URLs require credential-free HTTPS; loopback HTTP is accepted for
testing. The area-feed placeholders are allowed only in the path or query.

The default 720-hour coverage window makes the effective minimum track retention 31 days. Reducing
retention does not immediately shrink SQLite; freed pages are reused.

## Coverage settings

These are advanced settings. This document records current accepted inputs without adding new
validation or changing the runtime's existing defensive clamps.

| Variable | Default | Current accepted input |
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

Removed legacy settings fail startup: `SKYTRACE_INGEST_TOKEN`, `SKYTRACE_INGEST_TOKENS`,
`SKYTRACE_MAX_TRACK_QUERY_POINTS` and `SKYTRACE_REQUIRE_HTTPS`.
