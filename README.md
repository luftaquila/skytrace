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
npm run agent
```

For a local file, use `SKYTRACE_AIRCRAFT_FILE=/run/readsb/aircraft.json`.
`receiver/skytrace-agent.service` is a systemd unit template for receiver hosts.

## Server environment

- `SKYTRACE_DB_PATH`: SQLite path. Defaults to `data/skytrace.db`.
- `SKYTRACE_INGEST_TOKEN`: shared ingest token.
- `SKYTRACE_RECEIVER_TOKENS`: receiver-scoped tokens as JSON, for example
  `{"roof-01":"token-a","hill-02":"token-b"}`.
- `SKYTRACE_CURRENT_WINDOW_SECONDS`: live aircraft window. Defaults to `90`.
- `SKYTRACE_TRACK_MIN_INTERVAL_SECONDS`: minimum seconds between stored track
  points per receiver/aircraft. Defaults to `5`.

## Development

```sh
npm install
npm --prefix web install
npm run check
npm run build
npm start
```

The production image serves `web/dist` from the same Express process.

## Deployment notes

Create the server secret before Flux applies the deployment:

```sh
kubectl --kubeconfig /home/luftaquila/.kube/config -n skytrace create secret generic skytrace-secrets \
  --from-literal='SKYTRACE_RECEIVER_TOKENS={"roof-01":"replace-me"}'
```

The k3s manifest uses `ghcr.io/luftaquila/skytrace:latest`; the GitHub Actions
workflow builds that image on pushes to `main`.
