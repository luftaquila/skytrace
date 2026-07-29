#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "package-agent: $*" >&2
  exit 1
}

if [[ "$#" -ne 2 ]]; then
  die "usage: package-agent.sh VERSION OUTPUT_DIRECTORY"
fi

version=$1
output_directory=$2
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd -- "$script_directory/.." && pwd)

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "VERSION must be a stable vMAJOR.MINOR.PATCH version"

root_version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
  "$repository_root/package.json")
web_version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
  "$repository_root/web/package.json")
[[ "$root_version" == "$web_version" ]] \
  || die "root package version $root_version does not match web package version $web_version"
[[ "$version" == "v$root_version" ]] \
  || die "release version $version does not match package version v$root_version"

mkdir -p -- "$output_directory"
output_directory=$(cd -- "$output_directory" && pwd)
agent="skytrace-agent-$version"
archive="$output_directory/$agent.tar.gz"
checksum="$archive.sha256"
[[ ! -e "$archive" ]] || die "output already exists: $archive"
[[ ! -e "$checksum" ]] || die "output already exists: $checksum"

stage_root=$(mktemp -d "${TMPDIR:-/tmp}/skytrace-agent-package.XXXXXX")
cleanup() {
  rm -rf -- "$stage_root"
}
trap cleanup EXIT

install -d "$stage_root/$agent/bin" "$stage_root/$agent/src" "$stage_root/$agent/receiver"
install -m 0755 "$repository_root/bin/skytrace-agent.mjs" "$stage_root/$agent/bin/skytrace-agent.mjs"
install -m 0644 "$repository_root/src/stream-limit.mjs" "$stage_root/$agent/src/stream-limit.mjs"
install -m 0644 "$repository_root/src/normalize-readsb.mjs" "$stage_root/$agent/src/normalize-readsb.mjs"
install -m 0644 \
  "$repository_root/receiver/skytrace-agent.service" \
  "$repository_root/receiver/skytrace-agent.env.example" \
  "$stage_root/$agent/receiver/"
install -m 0644 "$repository_root/docs/receiver-agent.md" "$stage_root/$agent/README.md"
install -m 0644 "$repository_root/LICENSE" "$stage_root/$agent/LICENSE"

tar -C "$stage_root" -czf "$stage_root/$agent.tar.gz" "$agent"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$stage_root/$agent.tar.gz" | awk '{print $1}' > "$stage_root/$agent.tar.gz.sha256"
else
  shasum -a 256 "$stage_root/$agent.tar.gz" | awk '{print $1}' > "$stage_root/$agent.tar.gz.sha256"
fi

mv -- "$stage_root/$agent.tar.gz" "$stage_root/$agent.tar.gz.sha256" "$output_directory/"
echo "packaged $agent in $output_directory"
