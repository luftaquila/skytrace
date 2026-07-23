# Skytrace

Personal ADS-B receiver aggregation service for `sky.luftaquila.io`.

## Receiver input

Skytrace expects receiver-side decoded `readsb` or `dump1090` `aircraft.json`
payloads. A receiver can run:

```sh
SKYTRACE_SERVER_URL=https://sky.luftaquila.io \
SKYTRACE_RECEIVER_ID=roof-01 \
SKYTRACE_TOKEN=replace-me \
SKYTRACE_AIRCRAFT_URL=http://127.0.0.1/tar1090/data/aircraft.json \
SKYTRACE_INTERVAL_MS=3000 \
npm run agent
```

For a local file, use `SKYTRACE_AIRCRAFT_FILE=/run/readsb/aircraft.json`.
Receiver uploads default to every 3 seconds when `SKYTRACE_INTERVAL_MS` is omitted.
`receiver/skytrace-agent.service` is a systemd unit template for receiver hosts.

## Server environment

- `SKYTRACE_DB_PATH`: SQLite path. Defaults to `data/skytrace.db`.
- `SKYTRACE_INGEST_TOKEN`: shared ingest token.
- `SKYTRACE_RECEIVER_TOKENS`: receiver-scoped tokens as JSON, for example
  `{"roof-01":"token-a","hill-02":"token-b"}`.
- `SKYTRACE_CURRENT_WINDOW_SECONDS`: live aircraft window. Defaults to `90`.
- `SKYTRACE_TRACK_MIN_INTERVAL_SECONDS`: minimum seconds between stored track
  points per receiver/aircraft. Defaults to `3`.
- `SKYTRACE_POSITION_FILTER_MAX_MACH`: reject impossible position jumps above
  this estimated Mach number. Defaults to `3.5`.
- `SKYTRACE_COVERAGE_WINDOW_HOURS`: public coverage history window. Defaults
  to `720`.
- `SKYTRACE_COVERAGE_REFRESH_SECONDS`: interval between background coverage
  snapshots. Defaults to `180`.
- `SKYTRACE_COVERAGE_CELL_HORIZONTAL_STEP_NM`: horizontal resolution of the
  receiver-partitioned coverage evidence store. Defaults to half the mesh step
  (`1 NM` with the default mesh settings).
- `SKYTRACE_COVERAGE_CELL_VERTICAL_STEP_FT`: vertical resolution of the
  coverage evidence store. Defaults to half the mesh step (`400 ft`).
- `SKYTRACE_COVERAGE_AGGREGATION_CHUNK_SIZE`: maximum raw track rows processed
  in one worker transaction. Defaults to `5000`.

Coverage is calculated in a persistent worker thread. Raw tracks are consumed
incrementally into receiver-partitioned spatial cells, expired by
`SKYTRACE_COVERAGE_WINDOW_HOURS`, and then rendered into immutable snapshots.
During its lifetime the worker reuses completed receiver meshes and rebuilds
only partitions with new evidence, expired cells, or changed configuration.
The public coverage window is time-based; it is not truncated to a fixed number
of recent raw track points. Express continues serving live aircraft and SSE
traffic while the worker updates the next snapshot.

## Development

```sh
npm install
npm --prefix web install
npm run check
npm run build
npm start
```

The production image serves `web/dist` from the same Express process.

The public API intentionally hides exact receiver coordinates. Coverage is
published from historical aircraft positions through `/api/coverage`; selected
aircraft tracks can be exported as KML through `/api/aircraft/:hex/track.kml`.
New data paths must follow the partitioning, cursor, worker, and bounded-payload
rules in [`SCALING.md`](SCALING.md).

## Deployment notes

Create the server secret before Flux applies the deployment:

```sh
kubectl --kubeconfig /home/luftaquila/.kube/config -n skytrace create secret generic skytrace-secrets \
  --from-literal='SKYTRACE_RECEIVER_TOKENS={"roof-01":"replace-me"}'
```

The k3s manifest uses `ghcr.io/luftaquila/skytrace:latest`; the GitHub Actions
workflow builds that image on pushes to `main`.
