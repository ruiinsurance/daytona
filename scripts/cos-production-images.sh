#!/usr/bin/env bash
# Copyright 2026 Daytona Platforms Inc.
# SPDX-License-Identifier: AGPL-3.0

set -Eeuo pipefail

readonly EXPECTED_SOURCE_REVISION='620567fe1cb98a23d7aa143c9d9ca4821ab6dabd'
readonly EXPECTED_IMAGE_TAG='v0.190.0-cos-620567fe'
readonly EXPECTED_PLATFORM='linux/amd64'
readonly OCI_SOURCE='https://github.com/ruiinsurance/daytona'
readonly DEFAULT_REPOSITORY_PREFIX='daytona-local'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "${REPO_ROOT}" ]] || { printf 'error: script must run from a git worktree\n' >&2; exit 1; }

SOURCE_REVISION="${DAYTONA_SOURCE_REVISION:-${EXPECTED_SOURCE_REVISION}}"
IMAGE_TAG="${DAYTONA_IMAGE_TAG:-${EXPECTED_IMAGE_TAG}}"
PLATFORM="${DAYTONA_PLATFORM:-${EXPECTED_PLATFORM}}"
REPOSITORY_PREFIX="${DAYTONA_REPOSITORY_PREFIX:-${DEFAULT_REPOSITORY_PREFIX}}"
BASE_IMAGE_PREFIX="${DAYTONA_BASE_IMAGE_PREFIX:-}"
BUILD_HTTP_PROXY="${DAYTONA_BUILD_HTTP_PROXY:-}"
ALPINE_PACKAGE_MIRROR="${DAYTONA_ALPINE_PACKAGE_MIRROR:-}"
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_ROOT="${TEMP_ROOT%/}"
OUTPUT_DIR="${DAYTONA_OUTPUT_DIR:-${TEMP_ROOT}/daytona-cos-production-images/${IMAGE_TAG}}"

TEMP_CONTAINER_IDS=('')
TEMP_DIRS=('')
TEMP_FILES=('')
EXPORT_STAGING=''
EXPORT_LOCK=''
ALPINE_BUILDER_IMAGE=''
CREATED_GO_WORK_SUM=0

info() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local container_id
  local temp_dir
  local temp_file
  for container_id in "${TEMP_CONTAINER_IDS[@]}"; do
    [[ -n "${container_id}" ]] || continue
    docker rm -fv "${container_id}" >/dev/null 2>&1 || true
  done
  for temp_dir in "${TEMP_DIRS[@]}"; do
    [[ -n "${temp_dir}" ]] || continue
    [[ ! -d "${temp_dir}" ]] || rm -rf -- "${temp_dir}"
  done
  for temp_file in "${TEMP_FILES[@]}"; do
    [[ -n "${temp_file}" ]] || continue
    [[ ! -e "${temp_file}" && ! -L "${temp_file}" ]] || rm -f -- "${temp_file}"
  done
  if ((CREATED_GO_WORK_SUM)) && [[ -f "${REPO_ROOT}/go.work.sum" && ! -s "${REPO_ROOT}/go.work.sum" ]]; then
    rm -f -- "${REPO_ROOT}/go.work.sum"
  fi
  if [[ -n "${EXPORT_LOCK}" && -d "${EXPORT_LOCK}" ]]; then
    rmdir "${EXPORT_LOCK}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat <<'EOF'
Build, verify, and export Daytona COS production images without pushing them.

Usage:
  scripts/cos-production-images.sh <command> [options]

Commands:
  plan      Validate configuration and print the four-image build plan.
  build     Build and load all four linux/amd64 product images locally.
  verify    Verify image identity, OCI labels, runtime config, and artifacts.
  inspect   Alias for verify.
  export    Verify, then export one tar per image and write manifests.
  all       Run build, verify, and export in order.

Options:
  --repository-prefix PREFIX  Local repository prefix (default: daytona-local).
  --base-image-prefix PREFIX  Optional Docker Official Images mirror prefix.
  --build-http-proxy URL      Optional credential-free HTTP(S) build proxy.
  --alpine-package-mirror URL Optional HTTPS mirror for build-only APK packages.
  --output-dir DIRECTORY      Absolute export directory outside this worktree.
  --tag TAG                   Must be v0.190.0-cos-620567fe.
  --platform PLATFORM         Must be linux/amd64.
  --source-revision SHA       Must be the fixed COS source revision.
  -h, --help                  Show this help.

Equivalent environment variables:
  DAYTONA_REPOSITORY_PREFIX, DAYTONA_BASE_IMAGE_PREFIX,
  DAYTONA_BUILD_HTTP_PROXY, DAYTONA_ALPINE_PACKAGE_MIRROR,
  DAYTONA_OUTPUT_DIR, DAYTONA_IMAGE_TAG, DAYTONA_PLATFORM,
  DAYTONA_SOURCE_REVISION

There is intentionally no push command. Registry authentication and image push
require separate, explicit authorization.
EOF
}

component_role() {
  case "$1" in
    runner) printf 'base' ;;
    api|proxy|ssh-gateway) printf 'product' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_repository() {
  case "$1" in
    api) printf 'daytona-api' ;;
    runner) printf 'daytona-runner-base' ;;
    proxy) printf 'daytona-proxy' ;;
    ssh-gateway) printf 'daytona-ssh-gateway' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_dockerfile() {
  case "$1" in
    api) printf 'apps/api/Dockerfile' ;;
    runner) printf 'apps/runner/Dockerfile' ;;
    proxy) printf 'apps/proxy/Dockerfile' ;;
    ssh-gateway) printf 'apps/ssh-gateway/Dockerfile' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_target() {
  case "$1" in
    api) printf 'daytona' ;;
    runner) printf 'runner' ;;
    proxy) printf 'proxy' ;;
    ssh-gateway) printf 'ssh-gateway' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_artifact() {
  case "$1" in
    api) printf '/daytona/dist/apps/api/main.js' ;;
    runner) printf '/usr/local/bin/daytona-runner' ;;
    proxy) printf '/usr/local/bin/daytona-proxy' ;;
    ssh-gateway) printf '/usr/local/bin/daytona-ssh-gateway' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_entrypoint() {
  case "$1" in
    api) printf '["node","dist/apps/api/main.js"]' ;;
    runner) printf '["sh","-c","/usr/local/bin/dockerd-entrypoint.sh & daytona-runner"]' ;;
    proxy) printf '["daytona-proxy"]' ;;
    ssh-gateway) printf '["daytona-ssh-gateway"]' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_healthcheck() {
  case "$1" in
    api) printf '["CMD","curl","-f","http://localhost:3000/api/config"]' ;;
    runner) printf '["CMD","curl","-f","http://localhost:3003/"]' ;;
    proxy) printf '["CMD","curl","-f","http://localhost:4000/health"]' ;;
    ssh-gateway) printf 'null' ;;
    *) die "unknown component: $1" ;;
  esac
}

component_tar_file() {
  printf '%s_%s_linux-amd64.tar' "$1" "${IMAGE_TAG}"
}

image_reference() {
  printf '%s/%s:%s' "${REPOSITORY_PREFIX}" "$(component_repository "$1")" "${IMAGE_TAG}"
}

canonicalize_directory_path() {
  local candidate="$1"
  local existing="${candidate}"
  local suffix=''
  local segment
  local physical

  while [[ ! -e "${existing}" && ! -L "${existing}" ]]; do
    segment="${existing##*/}"
    suffix="/${segment}${suffix}"
    existing="${existing%/*}"
    [[ -n "${existing}" ]] || existing='/'
  done

  [[ -d "${existing}" ]] || die 'output directory ancestor must be a directory'
  physical=$(cd -P -- "${existing}" && pwd -P) || die 'failed to resolve output directory'
  if [[ "${physical}" == '/' ]]; then
    printf '/%s' "${suffix#/}"
  else
    printf '%s%s' "${physical}" "${suffix}"
  fi
}

validate_configuration() {
  [[ -n "${REPOSITORY_PREFIX}" ]] || die 'repository prefix must not be empty'
  [[ "${REPOSITORY_PREFIX}" != *[[:space:]]* ]] || die 'repository prefix must not contain whitespace'
  [[ "${REPOSITORY_PREFIX}" != */ ]] || die 'repository prefix must not end with a slash'
  [[ "${REPOSITORY_PREFIX}" != /* ]] || die 'repository prefix must not start with a slash'
  [[ "${REPOSITORY_PREFIX}" != *//* ]] || die 'repository prefix must not contain empty path segments'
  [[ "${REPOSITORY_PREFIX}" != *://* ]] || die 'repository prefix must not include a URL scheme'
  [[ "${REPOSITORY_PREFIX}" != *@* ]] || die 'repository prefix must not include a digest or credentials'
  [[ "${REPOSITORY_PREFIX}" =~ ^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$ || "${REPOSITORY_PREFIX}" =~ ^[a-z0-9]$ ]] ||
    die 'repository prefix contains unsupported characters'

  if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
    [[ "${BASE_IMAGE_PREFIX}" != *[[:space:]]* ]] || die 'base image prefix must not contain whitespace'
    [[ "${BASE_IMAGE_PREFIX}" != */ ]] || die 'base image prefix must not end with a slash'
    [[ "${BASE_IMAGE_PREFIX}" != /* ]] || die 'base image prefix must not start with a slash'
    [[ "${BASE_IMAGE_PREFIX}" != *://* ]] || die 'base image prefix must not include a URL scheme'
    [[ "${BASE_IMAGE_PREFIX}" != *//* ]] || die 'base image prefix must not contain empty path segments'
    [[ "${BASE_IMAGE_PREFIX}" != *@* ]] || die 'base image prefix must not include a digest or credentials'
    [[ "${BASE_IMAGE_PREFIX}" =~ ^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$ || "${BASE_IMAGE_PREFIX}" =~ ^[a-z0-9]$ ]] ||
      die 'base image prefix contains unsupported characters'
  fi

  if [[ -n "${BUILD_HTTP_PROXY}" ]]; then
    [[ "${BUILD_HTTP_PROXY}" != *[[:space:]]* ]] || die 'build HTTP proxy must not contain whitespace'
    [[ "${BUILD_HTTP_PROXY}" != *@* ]] || die 'build HTTP proxy must not contain credentials'
    [[ "${BUILD_HTTP_PROXY}" =~ ^https?://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/?$ ]] ||
      die 'build HTTP proxy must be an HTTP(S) URL with only a host and optional port'
    local proxy_authority="${BUILD_HTTP_PROXY#*://}"
    proxy_authority="${proxy_authority%/}"
    if [[ "${proxy_authority}" == *:* ]]; then
      local proxy_port="${proxy_authority##*:}"
      ((proxy_port >= 1 && proxy_port <= 65535)) || die 'build HTTP proxy port must be between 1 and 65535'
    fi
  fi

  if [[ -n "${ALPINE_PACKAGE_MIRROR}" ]]; then
    [[ "${ALPINE_PACKAGE_MIRROR}" != *[[:space:]]* ]] || die 'Alpine package mirror must not contain whitespace'
    [[ "${ALPINE_PACKAGE_MIRROR}" != *@* ]] || die 'Alpine package mirror must not contain credentials'
    [[ "${ALPINE_PACKAGE_MIRROR}" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(/[A-Za-z0-9._/-]+)?/?$ ]] ||
      die 'Alpine package mirror must be a credential-free HTTPS URL'
    [[ "${ALPINE_PACKAGE_MIRROR}" != *'/../'* && "${ALPINE_PACKAGE_MIRROR}" != */.. &&
      "${ALPINE_PACKAGE_MIRROR}" != *'/./'* && "${ALPINE_PACKAGE_MIRROR}" != */. ]] ||
      die 'Alpine package mirror must not contain dot path segments'
    ALPINE_PACKAGE_MIRROR="${ALPINE_PACKAGE_MIRROR%/}"
  fi

  [[ "${IMAGE_TAG}" == "${EXPECTED_IMAGE_TAG}" ]] || die "image tag must equal ${EXPECTED_IMAGE_TAG}"
  [[ "${PLATFORM}" == "${EXPECTED_PLATFORM}" ]] || die "platform must equal ${EXPECTED_PLATFORM}"
  [[ "${SOURCE_REVISION}" == "${EXPECTED_SOURCE_REVISION}" ]] ||
    die "source revision must equal ${EXPECTED_SOURCE_REVISION}"

  OUTPUT_DIR="${OUTPUT_DIR%/}"
  [[ -n "${OUTPUT_DIR}" && "${OUTPUT_DIR}" == /* && "${OUTPUT_DIR}" != '/' ]] ||
    die 'output directory must be an absolute, non-root path'
  [[ "${OUTPUT_DIR}" != *'/../'* && "${OUTPUT_DIR}" != */.. && "${OUTPUT_DIR}" != *'/./'* && "${OUTPUT_DIR}" != */. ]] ||
    die 'output directory must not contain dot path segments'
  [[ "${OUTPUT_DIR}" != *//* ]] || die 'output directory must not contain empty path segments'
  [[ ! -L "${OUTPUT_DIR}" ]] || die 'output directory must not be a symbolic link'
  OUTPUT_DIR="$(canonicalize_directory_path "${OUTPUT_DIR}")"
  local canonical_repo_root
  canonical_repo_root=$(cd -P -- "${REPO_ROOT}" && pwd -P) || die 'failed to resolve git worktree'
  case "${OUTPUT_DIR}/" in
    "${canonical_repo_root}/"*) die 'output directory must be outside the git worktree' ;;
  esac
}

verify_source_guard() {
  command -v git >/dev/null 2>&1 || die 'git is required'
  git -C "${REPO_ROOT}" cat-file -e "${SOURCE_REVISION}^{commit}" 2>/dev/null ||
    die "fixed source revision is unavailable: ${SOURCE_REVISION}"
  git -C "${REPO_ROOT}" merge-base --is-ancestor "${SOURCE_REVISION}" HEAD ||
    die "fixed source revision is not an ancestor of HEAD: ${SOURCE_REVISION}"

  local changed_path
  while IFS= read -r changed_path; do
    [[ -n "${changed_path}" ]] || continue
    case "${changed_path}" in
      scripts/cos-production-images.sh|scripts/cos-production-images.test.sh|docker/COS_PRODUCTION_IMAGES.md)
        ;;
      *)
        die "product source differs from fixed revision at undeclared path: ${changed_path}"
        ;;
    esac
  done < <(
    {
      git -C "${REPO_ROOT}" diff --name-only "${SOURCE_REVISION}" --
      git -C "${REPO_ROOT}" ls-files --others --exclude-standard
    } | LC_ALL=C sort -u
  )
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die 'docker CLI is required'
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'
  docker buildx version >/dev/null 2>&1 || die 'docker buildx is required'

  local builder_info
  builder_info=$(docker buildx inspect --bootstrap 2>&1) || die "docker buildx builder is unavailable: ${builder_info}"
  printf '%s\n' "${builder_info}" | grep -Fq 'linux/amd64' || die 'docker buildx builder does not support linux/amd64'
}

require_file_command() {
  command -v file >/dev/null 2>&1 || die 'file command is required for binary architecture verification'
}

print_plan() {
  printf 'component\trole\timage_reference\tplatform\tdockerfile\ttarget\n'
  local component
  for component in api runner proxy ssh-gateway; do
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${component}" \
      "$(component_role "${component}")" \
      "$(image_reference "${component}")" \
      "${PLATFORM}" \
      "$(component_dockerfile "${component}")" \
      "$(component_target "${component}")"
  done
  printf 'output_directory\t%s\n' "${OUTPUT_DIR}"
  printf 'source_revision\t%s\n' "${SOURCE_REVISION}"
  printf 'base_image_prefix\t%s\n' "${BASE_IMAGE_PREFIX:-docker.io/library}"
  printf 'build_http_proxy\t%s\n' "$([[ -n "${BUILD_HTTP_PROXY}" ]] && printf enabled || printf disabled)"
  printf 'alpine_package_mirror\t%s\n' "$([[ -n "${ALPINE_PACKAGE_MIRROR}" ]] && printf enabled || printf disabled)"
}

base_image_reference() {
  if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
    printf '%s/%s' "${BASE_IMAGE_PREFIX}" "$1"
  else
    printf '%s' "$1"
  fi
}

ensure_go_work_sum() {
  local go_work_sum="${REPO_ROOT}/go.work.sum"
  [[ ! -L "${go_work_sum}" ]] || die 'go.work.sum must not be a symbolic link'
  if [[ -e "${go_work_sum}" ]]; then
    [[ -f "${go_work_sum}" ]] || die 'go.work.sum exists and is not a regular file'
    [[ ! -s "${go_work_sum}" ]] || die 'go.work.sum already exists and is non-empty; refusing to overwrite it'
    info 'Using the existing empty go.work.sum build-context placeholder'
  else
    info 'Creating a temporary ignored go.work.sum build-context placeholder'
    : > "${go_work_sum}"
    CREATED_GO_WORK_SUM=1
  fi
  verify_source_guard
}

build_alpine_builder_image() {
  [[ -n "${ALPINE_PACKAGE_MIRROR}" ]] || return 0

  ALPINE_BUILDER_IMAGE='daytona-build-local/node-alpine-toolchain-amd64:v0.190.0-cos-620567fe'
  local context_args=()
  local proxy_args=()

  if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
    context_args+=(
      --build-context "node:22-alpine=docker-image://$(base_image_reference 'node:22-alpine')"
    )
  fi
  if [[ -n "${BUILD_HTTP_PROXY}" ]]; then
    proxy_args+=(--build-arg "http_proxy=${BUILD_HTTP_PROXY}")
  fi

  info 'Building the build-only linux/amd64 Alpine toolchain image'
  docker buildx build \
    --platform "${PLATFORM}" \
    --load \
    --file - \
    --tag "${ALPINE_BUILDER_IMAGE}" \
    --label "org.opencontainers.image.source=${OCI_SOURCE}" \
    --label "org.opencontainers.image.revision=${SOURCE_REVISION}" \
    --label "org.opencontainers.image.version=${IMAGE_TAG}" \
    --build-arg "ALPINE_PACKAGE_MIRROR=${ALPINE_PACKAGE_MIRROR}" \
    "${proxy_args[@]}" \
    "${context_args[@]}" \
    "${REPO_ROOT}" <<'EOF'
FROM node:22-alpine
ARG ALPINE_PACKAGE_MIRROR
RUN cp /etc/apk/repositories /tmp/apk-repositories && \
    sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_PACKAGE_MIRROR}#g" /etc/apk/repositories && \
    apk add --no-cache python3 py3-setuptools make g++ git && \
    mv /tmp/apk-repositories /etc/apk/repositories
EOF

  assert_equal "$(inspect_value "${ALPINE_BUILDER_IMAGE}" '{{.Os}}')" 'linux' 'Alpine builder image OS'
  assert_equal "$(inspect_value "${ALPINE_BUILDER_IMAGE}" '{{.Architecture}}')" 'amd64' 'Alpine builder image architecture'
}

build_computer_use_artifact() {
  require_file_command
  local helper_image='daytona-build-local/computer-use-amd64:v0.190.0-cos-620567fe'
  local container_id
  local artifact_tmp
  local context_args=()
  local proxy_args=()

  if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
    context_args+=(
      --build-context "ubuntu:22.04=docker-image://$(base_image_reference 'ubuntu:22.04')"
      --build-context "golang:1.23=docker-image://$(base_image_reference 'golang:1.23')"
    )
  fi
  if [[ -n "${BUILD_HTTP_PROXY}" ]]; then
    proxy_args+=(--build-arg "http_proxy=${BUILD_HTTP_PROXY}")
  fi

  info 'Building the required computer-use linux/amd64 helper artifact'
  docker buildx build \
    --platform "${PLATFORM}" \
    --load \
    --file "${REPO_ROOT}/hack/computer-use/Dockerfile" \
    --tag "${helper_image}" \
    --label "org.opencontainers.image.source=${OCI_SOURCE}" \
    --label "org.opencontainers.image.revision=${SOURCE_REVISION}" \
    --label "org.opencontainers.image.version=${IMAGE_TAG}" \
    "${proxy_args[@]}" \
    "${context_args[@]}" \
    "${REPO_ROOT}"

  container_id=$(docker create --platform "${PLATFORM}" "${helper_image}")
  TEMP_CONTAINER_IDS+=("${container_id}")
  mkdir -p "${REPO_ROOT}/dist/libs"
  artifact_tmp=$(mktemp "${REPO_ROOT}/dist/libs/.computer-use-amd64.XXXXXX")
  TEMP_FILES+=("${artifact_tmp}")
  docker cp "${container_id}:/app/computer-use" "${artifact_tmp}"
  docker rm -v "${container_id}" >/dev/null

  [[ -s "${artifact_tmp}" ]] || die 'computer-use helper artifact is empty'
  file "${artifact_tmp}" | grep -Eq 'ELF 64-bit.*x86-64' ||
    die 'computer-use helper artifact is not a linux/amd64 ELF binary'
  chmod 0755 "${artifact_tmp}"
  mv "${artifact_tmp}" "${REPO_ROOT}/dist/libs/computer-use-amd64"
}

build_component() {
  local component="$1"
  local dockerfile
  local target
  local reference
  local build_args

  dockerfile="$(component_dockerfile "${component}")"
  target="$(component_target "${component}")"
  reference="$(image_reference "${component}")"
  build_args=(
    docker buildx build
    --platform "${PLATFORM}"
    --load
    --file "${REPO_ROOT}/${dockerfile}"
    --target "${target}"
    --tag "${reference}"
    --label "org.opencontainers.image.source=${OCI_SOURCE}"
    --label "org.opencontainers.image.revision=${SOURCE_REVISION}"
    --label "org.opencontainers.image.version=${IMAGE_TAG}"
  )
  if [[ "${component}" != 'ssh-gateway' ]]; then
    build_args+=(--build-arg "VERSION=${IMAGE_TAG}")
  fi
  if [[ -n "${BUILD_HTTP_PROXY}" ]]; then
    build_args+=(--build-arg "http_proxy=${BUILD_HTTP_PROXY}")
  fi
  case "${component}" in
    api)
      if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
        build_args+=(
          --build-context "node:24-slim=docker-image://$(base_image_reference 'node:24-slim')"
        )
      fi
      ;;
    runner)
      if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
        build_args+=(
          --build-context "golang:1.25.11-alpine=docker-image://$(base_image_reference 'golang:1.25.11-alpine')"
          --build-context "docker:28.5.2-dind-alpine3.22=docker-image://$(base_image_reference 'docker:28.5.2-dind-alpine3.22')"
        )
      fi
      if [[ -n "${ALPINE_BUILDER_IMAGE}" ]]; then
        build_args+=(--build-context "node:22-alpine=docker-image://${ALPINE_BUILDER_IMAGE}")
      elif [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
        build_args+=(--build-context "node:22-alpine=docker-image://$(base_image_reference 'node:22-alpine')")
      fi
      ;;
    proxy|ssh-gateway)
      if [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
        build_args+=(
          --build-context "golang:1.25.11-alpine=docker-image://$(base_image_reference 'golang:1.25.11-alpine')"
          --build-context "alpine:3.23=docker-image://$(base_image_reference 'alpine:3.23')"
        )
      fi
      if [[ -n "${ALPINE_BUILDER_IMAGE}" ]]; then
        build_args+=(--build-context "node:22-alpine=docker-image://${ALPINE_BUILDER_IMAGE}")
      elif [[ -n "${BASE_IMAGE_PREFIX}" ]]; then
        build_args+=(--build-context "node:22-alpine=docker-image://$(base_image_reference 'node:22-alpine')")
      fi
      ;;
  esac
  build_args+=("${REPO_ROOT}")

  info "Building ${component}: ${reference} (${dockerfile}, target=${target})"
  "${build_args[@]}"
}

build_all() {
  ensure_go_work_sum
  build_computer_use_artifact
  build_alpine_builder_image
  local component
  for component in api runner proxy ssh-gateway; do
    build_component "${component}"
  done
}

inspect_value() {
  local reference="$1"
  local template="$2"
  docker image inspect --format "${template}" "${reference}"
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local description="$3"
  [[ "${actual}" == "${expected}" ]] ||
    die "${description}: expected ${expected}, got ${actual}"
}

verify_artifact() {
  local component="$1"
  local reference="$2"
  local artifact
  local container_id
  local check_dir
  local copied_artifact

  artifact="$(component_artifact "${component}")"
  check_dir=$(mktemp -d "${TEMP_ROOT}/daytona-image-artifact.XXXXXX")
  TEMP_DIRS+=("${check_dir}")
  copied_artifact="${check_dir}/artifact"
  container_id=$(docker create --platform "${PLATFORM}" "${reference}")
  TEMP_CONTAINER_IDS+=("${container_id}")
  docker cp "${container_id}:${artifact}" "${copied_artifact}"
  docker rm -v "${container_id}" >/dev/null

  [[ -s "${copied_artifact}" ]] || die "${component} product artifact is missing or empty: ${artifact}"
  if [[ "${component}" != 'api' ]]; then
    require_file_command
    file "${copied_artifact}" | grep -Eq 'ELF 64-bit.*x86-64' ||
      die "${component} product artifact is not a linux/amd64 ELF binary: ${artifact}"
  fi
  rm -rf -- "${check_dir}"
}

verify_component() {
  local component="$1"
  local reference
  local image_id
  local healthcheck

  reference="$(image_reference "${component}")"
  docker image inspect "${reference}" >/dev/null 2>&1 || die "local image is missing: ${reference}"

  assert_equal "$(inspect_value "${reference}" '{{.Os}}')" 'linux' "${component} image OS"
  assert_equal "$(inspect_value "${reference}" '{{.Architecture}}')" 'amd64' "${component} image architecture"
  assert_equal \
    "$(inspect_value "${reference}" '{{index .Config.Labels "org.opencontainers.image.source"}}')" \
    "${OCI_SOURCE}" \
    "${component} OCI source label"
  assert_equal \
    "$(inspect_value "${reference}" '{{index .Config.Labels "org.opencontainers.image.revision"}}')" \
    "${SOURCE_REVISION}" \
    "${component} OCI revision label"
  assert_equal \
    "$(inspect_value "${reference}" '{{index .Config.Labels "org.opencontainers.image.version"}}')" \
    "${IMAGE_TAG}" \
    "${component} OCI version label"
  assert_equal \
    "$(inspect_value "${reference}" '{{json .Config.Entrypoint}}')" \
    "$(component_entrypoint "${component}")" \
    "${component} entrypoint"

  healthcheck=$(inspect_value "${reference}" '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{else}}null{{end}}')
  assert_equal "${healthcheck}" "$(component_healthcheck "${component}")" "${component} healthcheck"

  verify_artifact "${component}" "${reference}"
  image_id=$(inspect_value "${reference}" '{{.Id}}')
  printf 'VERIFIED\t%s\t%s\t%s\t%s\n' "${component}" "${reference}" "${PLATFORM}" "${image_id}"
}

verify_all() {
  local component
  for component in api runner proxy ssh-gateway; do
    verify_component "${component}"
  done
}

ensure_new_export_directory() {
  [[ ! -L "${OUTPUT_DIR}" ]] || die 'output directory must not be a symbolic link'
  [[ ! -e "${OUTPUT_DIR}" ]] || die 'output directory must not already exist'
}

acquire_export_lock() {
  local output_parent="${OUTPUT_DIR%/*}"
  local output_name="${OUTPUT_DIR##*/}"
  local lock_dir="${output_parent}/.${output_name}.lock"

  mkdir -p "${output_parent}"
  mkdir "${lock_dir}" 2>/dev/null || die 'export lock already exists for output directory'
  EXPORT_LOCK="${lock_dir}"
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
  else
    die 'sha256sum or shasum is required'
  fi
}

verify_checksum_manifest() {
  local directory="$1"
  local manifest="${directory}/FILE-MANIFEST.sha256"
  local expected
  local file_name
  local actual

  while read -r expected file_name; do
    [[ -n "${expected}" && -n "${file_name}" ]] || die 'invalid checksum manifest line'
    file_name="${file_name#\*}"
    [[ -f "${directory}/${file_name}" ]] || die "checksum target is missing: ${file_name}"
    actual=$(sha256_file "${directory}/${file_name}")
    [[ "${actual}" == "${expected}" ]] || die "checksum verification failed: ${file_name}"
  done < "${manifest}"
}

export_all() {
  ensure_new_export_directory
  acquire_export_lock
  ensure_new_export_directory
  verify_all

  local output_parent
  local output_name
  output_parent="${OUTPUT_DIR%/*}"
  output_name="${OUTPUT_DIR##*/}"
  EXPORT_STAGING=$(mktemp -d "${output_parent}/.${output_name}.staging.XXXXXX")
  TEMP_DIRS+=("${EXPORT_STAGING}")

  local image_manifest="${EXPORT_STAGING}/IMAGE-MANIFEST.tsv"
  local checksum_manifest="${EXPORT_STAGING}/FILE-MANIFEST.sha256"
  local component
  local reference
  local tar_file
  local tar_path
  local tar_size
  local image_id
  local file_name
  local checksum

  printf 'component\trole\timage_reference\tplatform\timage_id\tsource_revision\timage_version\tdockerfile\ttarget\tartifact_path\ttar_file\ttar_size_bytes\n' > "${image_manifest}"
  for component in api runner proxy ssh-gateway; do
    reference="$(image_reference "${component}")"
    tar_file="$(component_tar_file "${component}")"
    tar_path="${EXPORT_STAGING}/${tar_file}"
    image_id=$(inspect_value "${reference}" '{{.Id}}')
    info "Exporting ${reference} to ${tar_file}"
    docker save --output "${tar_path}" "${reference}"
    tar_size=$(wc -c < "${tar_path}" | tr -d '[:space:]')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${component}" \
      "$(component_role "${component}")" \
      "${reference}" \
      "${PLATFORM}" \
      "${image_id}" \
      "${SOURCE_REVISION}" \
      "${IMAGE_TAG}" \
      "$(component_dockerfile "${component}")" \
      "$(component_target "${component}")" \
      "$(component_artifact "${component}")" \
      "${tar_file}" \
      "${tar_size}" >> "${image_manifest}"
  done

  : > "${checksum_manifest}"
  for file_name in \
    "$(component_tar_file api)" \
    "$(component_tar_file runner)" \
    "$(component_tar_file proxy)" \
    "$(component_tar_file ssh-gateway)" \
    'IMAGE-MANIFEST.tsv'
  do
    checksum=$(sha256_file "${EXPORT_STAGING}/${file_name}")
    printf '%s  %s\n' "${checksum}" "${file_name}" >> "${checksum_manifest}"
  done
  verify_checksum_manifest "${EXPORT_STAGING}"

  ensure_new_export_directory
  mv "${EXPORT_STAGING}" "${OUTPUT_DIR}"
  EXPORT_STAGING=''
  verify_checksum_manifest "${OUTPUT_DIR}"
  info "Delivery exported to ${OUTPUT_DIR}"
}

COMMAND="${1:-}"
if [[ -z "${COMMAND}" ]]; then
  usage >&2
  exit 1
fi
shift

if [[ "${COMMAND}" == '-h' || "${COMMAND}" == '--help' || "${COMMAND}" == 'help' ]]; then
  usage
  exit 0
fi

while (($# > 0)); do
  case "$1" in
    --repository-prefix)
      (($# >= 2)) || die '--repository-prefix requires a value'
      REPOSITORY_PREFIX="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die '--output-dir requires a value'
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --base-image-prefix)
      (($# >= 2)) || die '--base-image-prefix requires a value'
      BASE_IMAGE_PREFIX="$2"
      shift 2
      ;;
    --build-http-proxy)
      (($# >= 2)) || die '--build-http-proxy requires a value'
      BUILD_HTTP_PROXY="$2"
      shift 2
      ;;
    --alpine-package-mirror)
      (($# >= 2)) || die '--alpine-package-mirror requires a value'
      ALPINE_PACKAGE_MIRROR="$2"
      shift 2
      ;;
    --tag)
      (($# >= 2)) || die '--tag requires a value'
      IMAGE_TAG="$2"
      shift 2
      ;;
    --platform)
      (($# >= 2)) || die '--platform requires a value'
      PLATFORM="$2"
      shift 2
      ;;
    --source-revision)
      (($# >= 2)) || die '--source-revision requires a value'
      SOURCE_REVISION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

validate_configuration
verify_source_guard

case "${COMMAND}" in
  plan)
    print_plan
    ;;
  build)
    require_docker
    build_all
    ;;
  verify|inspect)
    require_docker
    verify_all
    ;;
  export)
    ensure_new_export_directory
    require_docker
    export_all
    ;;
  all)
    ensure_new_export_directory
    require_docker
    build_all
    verify_all
    export_all
    ;;
  *)
    usage >&2
    die "unknown command: ${COMMAND}"
    ;;
esac
