#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/magpie-bin-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
for spec in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64; do
  os="${spec%/*}"; arch="${spec#*/}"
  for name in magpie-tui-runtime magpie-tui-mcp-helper; do
    (cd "$root/runtime" && GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -o "$tmp/$name.$os-$arch" "./cmd/$name")
    cmp "$tmp/$name.$os-$arch" "$root/bin/$name.$os-$arch" >/dev/null || {
      echo "MISMATCH $name.$os-$arch — check Go toolchain and release source" >&2
      exit 1
    }
    echo "MATCH $name.$os-$arch"
  done
done
(cd "$root" && shasum -a 256 -c SHA256SUMS)
