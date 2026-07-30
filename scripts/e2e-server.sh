#!/usr/bin/env bash
set -euo pipefail

work_directory=$(mktemp -d "${TMPDIR:-/tmp}/skytrace-e2e.XXXXXX")
server="$work_directory/skytrace"
server_pid=

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work_directory"
}
trap cleanup EXIT HUP INT TERM

go build -o "$server" ./server

export PORT="${SKYTRACE_E2E_PORT:-4173}"
export SKYTRACE_DB_PATH="$work_directory/skytrace.db"
export SKYTRACE_RECEIVER_TOKENS='{"rx-1":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
export SKYTRACE_CURRENT_WINDOW_SECONDS=120
export SKYTRACE_MAX_OBSERVATION_AGE_SECONDS=120
export SKYTRACE_TRACK_MIN_INTERVAL_SECONDS=0
export SKYTRACE_STATIC_DIR="$PWD/web/dist"
# Keep the browser fixture deterministic and independent of external airfield downloads.
export SKYTRACE_AIRFIELDS_REFRESH_SECONDS=0
export SKYTRACE_AIRFIELDS_AIRPORTS_URL=http://127.0.0.1:1/airports.csv
export SKYTRACE_AIRFIELDS_RUNWAYS_URL=http://127.0.0.1:1/runways.csv

"$server" &
server_pid=$!
wait "$server_pid"
server_pid=
