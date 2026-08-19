#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dockerfile="$repo_root/apps/runner/Dockerfile"
runner_project="$repo_root/apps/runner/project.json"
asset_checker="$repo_root/hack/runner/verify-embedded-assets.sh"

fail() {
  printf 'runner_image_contract_test_failed:%s\n' "$1" >&2
  exit 1
}

[[ -x "$asset_checker" ]] || fail 'asset_checker_missing_or_not_executable'
grep -Fq 'COPY hack/runner/verify-embedded-assets.sh hack/runner/' "$dockerfile" \
  || fail 'dockerfile_does_not_copy_asset_checker'
grep -Fq 'verify-embedded-assets.sh /daytona' "$dockerfile" \
  || fail 'dockerfile_does_not_verify_built_assets'
grep -Fq -- '--skip-nx-cache' "$dockerfile" \
  || fail 'dockerfile_allows_stale_nx_runner_output'
grep -Fq 'test -s dist/apps/daemon-amd64' "$runner_project" \
  || fail 'daemon_copy_target_allows_empty_input'
grep -Fq 'test -s dist/libs/computer-use-amd64' "$runner_project" \
  || fail 'computer_use_copy_target_allows_empty_input'

"$asset_checker" "$repo_root"

temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT
mkdir -p "$temporary_root/apps/runner/pkg/daemon/static"

printf 'daemon' > "$temporary_root/apps/runner/pkg/daemon/static/daemon-amd64"
if "$asset_checker" "$temporary_root" >/dev/null 2>&1; then
  fail 'missing_computer_use_asset_was_accepted'
fi

printf 'computer-use' > "$temporary_root/apps/runner/pkg/daemon/static/daytona-computer-use"
"$asset_checker" "$temporary_root"

: > "$temporary_root/apps/runner/pkg/daemon/static/daemon-amd64"
if "$asset_checker" "$temporary_root" >/dev/null 2>&1; then
  fail 'empty_daemon_asset_was_accepted'
fi

printf 'runner_image_contract_test_passed\n'
