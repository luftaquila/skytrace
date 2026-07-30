#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "smoke-compose: $*" >&2
  exit 1
}

engine=${1:-}
[[ "$engine" == "docker" || "$engine" == "podman" ]] \
  || die "usage: smoke-compose.sh {docker|podman}"
command -v "$engine" >/dev/null 2>&1 || die "$engine is not installed"
"$engine" info >/dev/null
"$engine" compose version >/dev/null

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd -- "$script_directory/.." && pwd)
package_version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
  "$repository_root/package.json")
version="v$package_version"
suffix="$$"
project="skytrace-smoke-$suffix"
registry_container="$project-registry"
source_volume="$project-data"
restored_volume="$project-restored"
registry_port=${SKYTRACE_SMOKE_REGISTRY_PORT:-$((45000 + suffix % 1000))}
app_port=${SKYTRACE_SMOKE_APP_PORT:-$((46000 + suffix % 1000))}
registry_ref="127.0.0.1:$registry_port/skytrace"
work_directory=$(mktemp -d "${TMPDIR:-/tmp}/skytrace-compose-smoke.XXXXXX")
work_directory=$(cd -- "$work_directory" && pwd -P)
compose_file="$work_directory/compose.yml"
env_file="$work_directory/.env"
good_ref=

if [[ "$engine" == "podman" ]]; then
  registries_conf="$work_directory/registries.conf"
  printf '[[registry]]\nlocation = "127.0.0.1:%s"\ninsecure = true\n' "$registry_port" \
    > "$registries_conf"
  export CONTAINERS_REGISTRIES_CONF="$registries_conf"
fi

compose_cmd() {
  "$engine" compose \
    -p "$project" \
    --env-file "$env_file" \
    -f "$compose_file" \
    "$@"
}

cleanup() {
  if [[ -f "$compose_file" && -f "$env_file" ]]; then
    compose_cmd down --remove-orphans >/dev/null 2>&1 || true
  fi
  "$engine" rm -f "$registry_container" >/dev/null 2>&1 || true
  "$engine" volume rm "$source_volume" "$restored_volume" >/dev/null 2>&1 || true
  "$engine" network rm "${project}_default" >/dev/null 2>&1 || true
  if [[ -n "$good_ref" ]]; then
    "$engine" image rm -f "$good_ref" >/dev/null 2>&1 || true
  fi
  "$engine" image rm -f "$registry_ref:smoke" >/dev/null 2>&1 || true
  rm -rf -- "$work_directory"
}
trap cleanup EXIT

wait_registry() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$registry_port/v2/" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$app_port/healthz" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

manifest_digest() {
  local tag=$1
  local digest
  digest=$(curl -fsSI \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "http://127.0.0.1:$registry_port/v2/skytrace/manifests/$tag" \
    | tr -d '\r' \
    | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p' \
    | tail -n 1)
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "registry returned an invalid digest for $tag"
  printf '%s' "$digest"
}

set_env() {
  local file=$1
  local key=$2
  local value=$3
  local temporary="$file.tmp"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" > "$temporary"
  mv -- "$temporary" "$file"
}

echo "starting the local $engine registry"
"$engine" run -d \
  --name "$registry_container" \
  --publish "127.0.0.1:$registry_port:5000" \
  registry:2 >/dev/null
wait_registry || die "local registry did not become ready"

echo "building and publishing the smoke image"
"$engine" build -t "$registry_ref:smoke" "$repository_root"
if [[ "$engine" == "podman" ]]; then
  "$engine" push --tls-verify=false "$registry_ref:smoke"
else
  "$engine" push "$registry_ref:smoke"
fi
good_digest=$(manifest_digest smoke)
good_ref="$registry_ref@$good_digest"

install -m 0644 "$repository_root/compose.yml" "$compose_file"
install -m 0600 /dev/null "$env_file"
token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
set_env "$env_file" SKYTRACE_IMAGE "$good_ref"
set_env "$env_file" SKYTRACE_BIND 127.0.0.1
set_env "$env_file" SKYTRACE_PORT "$app_port"
set_env "$env_file" SKYTRACE_VOLUME "$source_volume"
set_env "$env_file" SKYTRACE_BACKUP_DIR ./backups
set_env "$env_file" SKYTRACE_RECEIVER_TOKENS "{\"smoke-rx\":\"$token\"}"
install -d -m 0700 "$work_directory/backups"

echo "starting Skytrace through $engine compose"
if [[ "$engine" == "podman" ]]; then
  "$engine" pull --tls-verify=false "$good_ref"
else
  compose_cmd pull
fi
compose_cmd up -d
wait_health || die "Skytrace did not become healthy"

image_architecture=$("$engine" image inspect "$good_ref" --format '{{.Architecture}}')
case "$image_architecture" in
  amd64|x86_64)
    agent_target=linux-amd64
    ;;
  arm64|aarch64)
    agent_target=linux-arm64
    ;;
  *)
    die "unsupported smoke image architecture: $image_architecture"
    ;;
esac
"$repository_root/scripts/package-agent.sh" "$version" "$agent_target" "$work_directory"
tar -C "$work_directory" \
  -xzf "$work_directory/skytrace-agent-$version-$agent_target.tar.gz"
agent_directory="$work_directory/skytrace-agent-$version-$agent_target"
aircraft_file="$work_directory/aircraft.json"
node -e '
  process.stdout.write(JSON.stringify({
    now: Date.now() / 1000,
    aircraft: [{
      hex: "abc123",
      flight: "SMOKE1",
      lat: 37.5,
      lon: 127.1,
      alt_baro: 12000,
      gs: 250,
      track: 90,
      seen: 0.1,
      seen_pos: 0.1
    }]
  }))
' > "$aircraft_file"

echo "uploading through the extracted receiver agent"
skytrace_container=$(compose_cmd ps -q skytrace)
[[ -n "$skytrace_container" ]] || die "could not resolve the Skytrace container"
"$engine" cp "$agent_directory/bin/skytrace-agent" \
  "$skytrace_container:/tmp/skytrace-agent-smoke"
"$engine" cp "$aircraft_file" "$skytrace_container:/tmp/aircraft-smoke.json"
"$engine" exec \
  -e SKYTRACE_SERVER_URL=http://127.0.0.1:3000 \
  -e SKYTRACE_RECEIVER_ID=smoke-rx \
  -e SKYTRACE_TOKEN="$token" \
  -e SKYTRACE_AIRCRAFT_FILE=/tmp/aircraft-smoke.json \
  "$skytrace_container" \
  /tmp/skytrace-agent-smoke --once
curl -fsS "http://127.0.0.1:$app_port/api/live" | grep -q 'abc123'

backup_file="skytrace-data-$suffix.tar.gz"
echo "backing up through the Compose ops service"
compose_cmd stop skytrace
if compose_cmd --profile ops run --rm -e SKYTRACE_BACKUP_FILE=../escape.tar.gz backup; then
  die "backup accepted a path outside SKYTRACE_BACKUP_DIR"
fi
[[ ! -e "$work_directory/escape.tar.gz" ]] \
  || die "backup wrote outside SKYTRACE_BACKUP_DIR"
compose_cmd --profile ops run --rm -e SKYTRACE_BACKUP_FILE="$backup_file" backup
compose_cmd start skytrace
wait_health || die "Skytrace did not recover after backup"
compose_cmd --profile ops run --rm \
  -e SKYTRACE_RESTORE_FILE="$backup_file" \
  --entrypoint /bin/sh \
  restore -c "tar -tzf /backup/$backup_file >/dev/null"

echo "restoring through the same Compose file to a new volume"
compose_cmd stop skytrace
set_env "$env_file" SKYTRACE_VOLUME "$restored_volume"
compose_cmd --profile ops run --rm -e SKYTRACE_RESTORE_FILE="$backup_file" restore
compose_cmd up -d --force-recreate
wait_health || die "restored Skytrace did not become healthy"
curl -fsS "http://127.0.0.1:$app_port/api/live" | grep -q 'abc123'

echo "$engine Compose smoke passed"
