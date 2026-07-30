#!/usr/bin/env bash
# Copyright 2026 Daytona Platforms Inc.
# SPDX-License-Identifier: AGPL-3.0

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/cos-production-images.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_ROOT="${TEMP_ROOT%/}"
TEST_ROOT="$(mktemp -d "${TEMP_ROOT}/daytona-cos-image-tests.XXXXXX")"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

passed=0
failed=0

pass() {
  printf 'ok - %s\n' "$1"
  passed=$((passed + 1))
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  failed=$((failed + 1))
}

expect_success() {
  local name="$1"
  shift
  local output
  if output=$("$@" 2>&1); then
    pass "${name}"
  else
    fail "${name}"
    printf '%s\n' "${output}" >&2
  fi
}

expect_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  if output=$("$@" 2>&1); then
    fail "${name}: command unexpectedly succeeded"
  elif printf '%s' "${output}" | grep -Fq "${expected}"; then
    pass "${name}"
  else
    fail "${name}: expected error containing ${expected}"
    printf '%s\n' "${output}" >&2
  fi
}

plan_output="${TEST_ROOT}/plan-output"
expect_success \
  'plan accepts an explicit immutable local repository prefix' \
  bash "${SCRIPT}" plan \
  --repository-prefix registry.example.com/ruiinsurance \
  --base-image-prefix public.ecr.aws/docker/library \
  --build-http-proxy http://host.docker.internal:3128 \
  --alpine-package-mirror https://mirrors.cloud.tencent.com/alpine \
  --output-dir "${plan_output}"

plan=$(bash "${SCRIPT}" plan \
  --repository-prefix registry.example.com/ruiinsurance \
  --base-image-prefix public.ecr.aws/docker/library \
  --build-http-proxy http://host.docker.internal:3128 \
  --alpine-package-mirror https://mirrors.cloud.tencent.com/alpine \
  --output-dir "${plan_output}")

for expected in \
  'api\tproduct\tregistry.example.com/ruiinsurance/daytona-api:v0.190.0-cos-620567fe\tlinux/amd64\tapps/api/Dockerfile\tdaytona' \
  'runner\tbase\tregistry.example.com/ruiinsurance/daytona-runner-base:v0.190.0-cos-620567fe\tlinux/amd64\tapps/runner/Dockerfile\trunner' \
  'proxy\tproduct\tregistry.example.com/ruiinsurance/daytona-proxy:v0.190.0-cos-620567fe\tlinux/amd64\tapps/proxy/Dockerfile\tproxy' \
  'ssh-gateway\tproduct\tregistry.example.com/ruiinsurance/daytona-ssh-gateway:v0.190.0-cos-620567fe\tlinux/amd64\tapps/ssh-gateway/Dockerfile\tssh-gateway'
do
  if printf '%s\n' "${plan}" | grep -Fq "$(printf '%b' "${expected}")"; then
    pass "plan contains ${expected%%\\t*} identity"
  else
    fail "plan contains ${expected%%\\t*} identity"
  fi
done

if printf '%s\n' "${plan}" | grep -Fq $'base_image_prefix\tpublic.ecr.aws/docker/library'; then
  pass 'plan contains the explicit base image mirror prefix'
else
  fail 'plan contains the explicit base image mirror prefix'
fi

if printf '%s\n' "${plan}" | grep -Fq $'build_http_proxy\tenabled'; then
  pass 'plan reports an enabled build HTTP proxy without printing its URL'
else
  fail 'plan reports an enabled build HTTP proxy without printing its URL'
fi

if printf '%s\n' "${plan}" | grep -Fq $'alpine_package_mirror\tenabled'; then
  pass 'plan reports an enabled Alpine package mirror without printing its URL'
else
  fail 'plan reports an enabled Alpine package mirror without printing its URL'
fi

expect_failure \
  'empty repository prefix is rejected' \
  'repository prefix must not be empty' \
  bash "${SCRIPT}" plan --repository-prefix '' --output-dir "${TEST_ROOT}/empty-prefix"

expect_failure \
  'mutable latest tag is rejected' \
  'image tag must equal v0.190.0-cos-620567fe' \
  env DAYTONA_IMAGE_TAG=latest bash "${SCRIPT}" plan --output-dir "${TEST_ROOT}/latest"

expect_failure \
  'non-amd64 platform is rejected' \
  'platform must equal linux/amd64' \
  env DAYTONA_PLATFORM=linux/arm64 bash "${SCRIPT}" plan --output-dir "${TEST_ROOT}/arm64"

expect_failure \
  'wrong source revision is rejected' \
  'source revision must equal 620567fe1cb98a23d7aa143c9d9ca4821ab6dabd' \
  env DAYTONA_SOURCE_REVISION=deadbeef bash "${SCRIPT}" plan --output-dir "${TEST_ROOT}/revision"

expect_failure \
  'repository output directory is rejected' \
  'output directory must be outside the git worktree' \
  bash "${SCRIPT}" plan --output-dir "${REPO_ROOT}/delivery"

repo_link="${TEST_ROOT}/repo-link"
ln -s "${REPO_ROOT}" "${repo_link}"
expect_failure \
  'repository output directory reached through a symlinked ancestor is rejected' \
  'output directory must be outside the git worktree' \
  bash "${SCRIPT}" plan --output-dir "${repo_link}/delivery"

mock_bin="${TEST_ROOT}/mock-bin"
mkdir -p "${mock_bin}"
cat > "${mock_bin}/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  info)
    exit 0
    ;;
  buildx)
    case "${2:-}" in
      version)
        exit 0
        ;;
      inspect)
        printf 'Platforms: linux/amd64\n'
        exit 0
        ;;
    esac
    ;;
esac
exit 99
EOF
chmod +x "${mock_bin}/docker"

bash32_repo="${TEST_ROOT}/bash32-repo"
bash32_mock_bin="${TEST_ROOT}/bash32-mock-bin"
bash32_docker_log="${TEST_ROOT}/bash32-docker.log"
git clone --quiet --shared "${REPO_ROOT}" "${bash32_repo}"
cp "${SCRIPT}" "${bash32_repo}/scripts/cos-production-images.sh"
mkdir -p "${bash32_mock_bin}"
cat > "${bash32_mock_bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s' "${1:-}" >> "${BASH32_DOCKER_LOG}"
for argument in "${@:2}"; do
  printf '\t%s' "${argument}" >> "${BASH32_DOCKER_LOG}"
done
printf '\n' >> "${BASH32_DOCKER_LOG}"

case "${1:-}" in
  info)
    exit 0
    ;;
  buildx)
    case "${2:-}" in
      version|build)
        exit 0
        ;;
      inspect)
        printf 'Platforms: linux/amd64\n'
        exit 0
        ;;
    esac
    ;;
  create)
    printf 'bash32-container\n'
    exit 0
    ;;
  cp)
    printf 'fake computer-use artifact\n' > "${3}"
    exit 0
    ;;
  rm)
    exit 0
    ;;
esac
exit 99
EOF
cat > "${bash32_mock_bin}/file" <<'EOF'
#!/usr/bin/env bash
printf '%s: ELF 64-bit LSB executable, x86-64\n' "${1:-artifact}"
EOF
chmod +x "${bash32_mock_bin}/docker" "${bash32_mock_bin}/file"

expect_success \
  'Bash 3.2 build supports empty optional proxy and mirror argument arrays' \
  env PATH="${bash32_mock_bin}:${PATH}" BASH32_DOCKER_LOG="${bash32_docker_log}" \
  /bin/bash "${bash32_repo}/scripts/cos-production-images.sh" build \
  --repository-prefix registry.example.com/ruiinsurance \
  --output-dir "${TEST_ROOT}/bash32-output"
if [[ "$(grep -c $'^buildx\\tbuild\\t' "${bash32_docker_log}" || true)" -eq 5 ]]; then
  pass 'Bash 3.2 build reaches the helper and four product buildx calls'
else
  fail 'Bash 3.2 build reaches the helper and four product buildx calls'
fi

empty_output="${TEST_ROOT}/empty"
mkdir -p "${empty_output}"
expect_failure \
  'export refuses an existing empty output directory before Docker access' \
  'output directory must not already exist' \
  env PATH="${mock_bin}:${PATH}" bash "${SCRIPT}" export --output-dir "${empty_output}"

nonempty_output="${TEST_ROOT}/nonempty"
mkdir -p "${nonempty_output}"
touch "${nonempty_output}/existing-file"
expect_failure \
  'export refuses a nonempty output directory before Docker access' \
  'output directory must not already exist' \
  bash "${SCRIPT}" export --output-dir "${nonempty_output}"

locked_output="${TEST_ROOT}/locked-output"
mkdir "${TEST_ROOT}/.locked-output.lock"
expect_failure \
  'export refuses an output target locked by another process' \
  'export lock already exists for output directory' \
  env PATH="${mock_bin}:${PATH}" bash "${SCRIPT}" export --output-dir "${locked_output}"

signal_mock_bin="${TEST_ROOT}/signal-mock-bin"
signal_ready="${TEST_ROOT}/signal-ready"
signal_output="${TEST_ROOT}/signal-output"
mkdir -p "${signal_mock_bin}"
cat > "${signal_mock_bin}/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  info)
    exit 0
    ;;
  buildx)
    case "${2:-}" in
      version)
        exit 0
        ;;
      inspect)
        printf 'Platforms: linux/amd64\n'
        exit 0
        ;;
    esac
    ;;
  image)
    if [[ "${2:-}" == 'inspect' && " $* " != *' --format '* ]]; then
      : > "${SIGNAL_READY_FILE}"
      sleep 1
      exit 0
    fi
    ;;
esac
exit 99
EOF
chmod +x "${signal_mock_bin}/docker"
env PATH="${signal_mock_bin}:${PATH}" SIGNAL_READY_FILE="${signal_ready}" \
  bash "${SCRIPT}" export --output-dir "${signal_output}" > "${TEST_ROOT}/signal.log" 2>&1 &
signal_pid=$!
for _ in {1..100}; do
  [[ ! -e "${signal_ready}" ]] || break
  sleep 0.02
done
if [[ -e "${signal_ready}" ]]; then
  kill -TERM "${signal_pid}"
else
  fail 'signal test reaches verification while holding the export lock'
  kill -KILL "${signal_pid}" >/dev/null 2>&1 || true
fi
set +e
wait "${signal_pid}"
signal_status=$?
set -e
if [[ "${signal_status}" -eq 143 ]]; then
  pass 'TERM exits an export process with status 143'
else
  fail "TERM exits an export process with status 143: got ${signal_status}"
fi
if [[ ! -e "${TEST_ROOT}/.signal-output.lock" ]]; then
  pass 'TERM removes the export lock through EXIT cleanup'
else
  fail 'TERM removes the export lock through EXIT cleanup'
fi

isolated_repo="${TEST_ROOT}/isolated-repo"
git clone --quiet --shared "${REPO_ROOT}" "${isolated_repo}"
cp "${SCRIPT}" "${isolated_repo}/scripts/cos-production-images.sh"
printf 'must-not-be-truncated\n' > "${isolated_repo}/go.work.sum"
expect_failure \
  'build refuses a pre-existing nonempty go.work.sum' \
  'go.work.sum already exists and is non-empty' \
  env PATH="${mock_bin}:${PATH}" bash "${isolated_repo}/scripts/cos-production-images.sh" build \
  --output-dir "${TEST_ROOT}/isolated-output"
if [[ "$(cat "${isolated_repo}/go.work.sum")" == 'must-not-be-truncated' ]]; then
  pass 'build preserves a pre-existing nonempty go.work.sum'
else
  fail 'build preserves a pre-existing nonempty go.work.sum'
fi

expect_failure \
  'unknown options are rejected' \
  'unknown option: --push' \
  bash "${SCRIPT}" plan --push

expect_failure \
  'base image prefix with a URL scheme is rejected' \
  'base image prefix must not include a URL scheme' \
  bash "${SCRIPT}" plan --base-image-prefix https://public.ecr.aws/docker/library

expect_failure \
  'build HTTP proxy credentials are rejected' \
  'build HTTP proxy must not contain credentials' \
  bash "${SCRIPT}" plan --build-http-proxy http://user:secret@proxy.example.com:3128

expect_failure \
  'out-of-range build HTTP proxy port is rejected' \
  'build HTTP proxy port must be between 1 and 65535' \
  bash "${SCRIPT}" plan --build-http-proxy http://proxy.example.com:70000

expect_failure \
  'insecure Alpine package mirror is rejected' \
  'Alpine package mirror must be a credential-free HTTPS URL' \
  bash "${SCRIPT}" plan --alpine-package-mirror http://mirrors.example.com/alpine

expect_failure \
  'Alpine package mirror credentials are rejected' \
  'Alpine package mirror must not contain credentials' \
  bash "${SCRIPT}" plan --alpine-package-mirror https://user:secret@mirrors.example.com/alpine

printf '%s\n' "${passed} passed; ${failed} failed"
if ((failed > 0)); then
  exit 1
fi
