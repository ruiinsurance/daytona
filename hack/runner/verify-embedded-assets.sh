#!/bin/sh

set -eu

workspace_root=${1:-.}
static_root="$workspace_root/apps/runner/pkg/daemon/static"

for asset in daemon-amd64 daytona-computer-use; do
  asset_path="$static_root/$asset"
  if [ ! -f "$asset_path" ] || [ ! -s "$asset_path" ]; then
    printf 'runner_embedded_asset_missing:%s\n' "$asset" >&2
    exit 1
  fi
done

printf 'runner_embedded_assets_present\n'
