#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "package-agent: $*" >&2
  exit 1
}

if [[ "$#" -ne 3 ]]; then
  die "usage: package-agent.sh VERSION TARGET OUTPUT_DIRECTORY"
fi

version=$1
target=$2
output_directory=$3
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

goos=linux
goarch=
variant_name=
variant_value=
case "$target" in
  linux-amd64)
    goarch=amd64
    variant_name=GOAMD64
    variant_value=v1
    ;;
  linux-armv6)
    goarch=arm
    variant_name=GOARM
    variant_value=6
    ;;
  linux-armv7)
    goarch=arm
    variant_name=GOARM
    variant_value=7
    ;;
  linux-arm64)
    goarch=arm64
    variant_name=GOARM64
    variant_value=v8.0
    ;;
  linux-riscv64)
    goarch=riscv64
    variant_name=GORISCV64
    variant_value=rva20u64
    ;;
  *)
    die "unsupported target: $target"
    ;;
esac
command -v go >/dev/null 2>&1 || die "go is not installed"

mkdir -p -- "$output_directory"
output_directory=$(cd -- "$output_directory" && pwd)
agent="skytrace-agent-$version-$target"
archive="$output_directory/$agent.tar.gz"
[[ ! -e "$archive" ]] || die "output already exists: $archive"

stage_root=$(mktemp -d "${TMPDIR:-/tmp}/skytrace-agent-package.XXXXXX")
cleanup() {
  rm -rf -- "$stage_root"
}
trap cleanup EXIT

install -d "$stage_root/$agent/bin" "$stage_root/$agent/receiver"
env \
  CGO_ENABLED=0 \
  GOOS="$goos" \
  GOARCH="$goarch" \
  "$variant_name=$variant_value" \
  go build \
    -C "$repository_root" \
    -buildvcs=false \
    -trimpath \
    -ldflags="-s -w -X main.version=$version" \
    -o "$stage_root/$agent/bin/skytrace-agent" \
    ./receiver/agent
chmod 0755 "$stage_root/$agent/bin/skytrace-agent"
go version -m "$stage_root/$agent/bin/skytrace-agent" \
  | grep -F $'\tbuild\tGOOS='"$goos" >/dev/null \
  || die "built binary does not report GOOS=$goos"
go version -m "$stage_root/$agent/bin/skytrace-agent" \
  | grep -F $'\tbuild\tGOARCH='"$goarch" >/dev/null \
  || die "built binary does not report GOARCH=$goarch"
go version -m "$stage_root/$agent/bin/skytrace-agent" \
  | grep -F $'\tbuild\t'"$variant_name"'='"$variant_value" >/dev/null \
  || die "built binary does not report $variant_name=$variant_value"
install -m 0644 \
  "$repository_root/receiver/agent/skytrace-agent.service" \
  "$repository_root/receiver/agent/skytrace-agent.env.example" \
  "$stage_root/$agent/receiver/"
install -m 0644 "$repository_root/docs/receiver-agent.md" "$stage_root/$agent/README.md"
install -m 0644 "$repository_root/LICENSE" "$stage_root/$agent/LICENSE"

tar -C "$stage_root" -czf "$stage_root/$agent.tar.gz" "$agent"
mv -- "$stage_root/$agent.tar.gz" "$output_directory/"
echo "packaged $agent in $output_directory"
