#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Switch the daytona-v190 Compose project from Tencent COS to the local MinIO
# instance backed by /app/data/minio/data. The script is intentionally staged:
# plan -> prepare -> cutover, with rollback available after cutover.

readonly SCRIPT_VERSION="1"
readonly PROJECT="daytona-v190"
readonly COMPOSE_DIR="/app/service/daytona-v190"
readonly ENV_FILE="${COMPOSE_DIR}/.env"
readonly COS_ENV_FILE="${COMPOSE_DIR}/cos.env"
readonly BASE_COMPOSE="${COMPOSE_DIR}/docker-compose.yaml"
readonly SITE_OVERRIDE="${COMPOSE_DIR}/docker-compose.override.yaml"
readonly IMAGES_OVERRIDE="${COMPOSE_DIR}/docker-compose.images.override.yaml"
readonly COS_OVERRIDE="${COMPOSE_DIR}/docker-compose.cos.override.yaml"
readonly LOCAL_ENV_FILE="${COMPOSE_DIR}/daytona190-local-minio.env"
readonly LOCAL_OVERRIDE="${COMPOSE_DIR}/docker-compose.local-minio.override.yaml"
readonly STATE_DIR="${COMPOSE_DIR}/daytona190-local-minio-state"
readonly LOCK_DIR="${STATE_DIR}/.lock"
readonly MINIO_CONTAINER="${PROJECT}-minio-1"
readonly API_CONTAINER="${PROJECT}-api-1"
readonly RUNNER_CONTAINER="${PROJECT}-runner-1"
readonly MINIO_DATA_DIR="/app/data/minio/data"
readonly MC_IMAGE="${DAYTONA190_MC_IMAGE:-minio/mc:latest}"
readonly APPLY_CONFIRMATION="DAYTONA190_LOCAL_MINIO_CUTOVER_CONFIRMED"
readonly FRESH_CONFIRMATION="DAYTONA190_LOCAL_MINIO_FRESH_CONFIRMED"
readonly ROLLBACK_CONFIRMATION="DAYTONA190_LOCAL_MINIO_ROLLBACK_CONFIRMED"

MODE="${1:-plan}"
CONFIRMATION="${2:-}"
COS_ENDPOINT=""
COS_REGION=""
COS_ACCESS_KEY=""
COS_SECRET_KEY=""
COS_BUCKET=""
COS_LAYOUT=""
COS_PREFIX=""
MINIO_ACCESS_KEY=""
MINIO_SECRET_KEY=""
MINIO_REGION=""
MINIO_MC_ENDPOINT=""
MC_CONFIG_DIR=""
MC_MODE=""
LOCK_HELD="no"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[daytona190-local-minio] %s\n' "$*"
}

warn() {
  printf '[daytona190-local-minio] warning: %s\n' "$*" >&2
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo bash /tmp/daytona190-local-minio-cutover.sh plan
  sudo bash /tmp/daytona190-local-minio-cutover.sh prepare
  sudo bash /tmp/daytona190-local-minio-cutover.sh cutover DAYTONA190_LOCAL_MINIO_CUTOVER_CONFIRMED
  sudo bash /tmp/daytona190-local-minio-cutover.sh fresh-cutover DAYTONA190_LOCAL_MINIO_FRESH_CONFIRMED
  sudo bash /tmp/daytona190-local-minio-cutover.sh rollback DAYTONA190_LOCAL_MINIO_ROLLBACK_CONFIRMED
  sudo bash /tmp/daytona190-local-minio-cutover.sh status

Stages:
  plan     Read-only validation and current COS/MinIO status.
  prepare  Write a local MinIO Compose override, start MinIO, and mirror the
           current COS bucket into MinIO. API and Runner remain on COS.
  cutover  Stop API/Runner, run one final mirror, then recreate API/Runner
           with the local MinIO endpoint.
  fresh-cutover  Discard all local MinIO objects, create an empty bucket, and
                 switch API/Runner to local MinIO without reading or syncing COS.
  rollback Recreate API/Runner with the original COS Compose override. It does
           not delete the local MinIO data or modify COS.
  status   Show the saved cutover state and container health without changing it.

The script never deletes COS objects. Run prepare before cutover.
USAGE
  exit 2
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

trim_quotes() {
  local value="$1"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$value" == '"'*'"' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == "'*'" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

dotenv_value() {
  local key="$1"
  local file="$2"
  local raw

  raw="$(awk -v wanted="$key" '
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (line ~ /^[[:space:]]*#/ || line !~ /=/) next
      name = line
      sub(/=.*/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) {
        sub(/^[^=]*=/, "", line)
        print line
        exit
      }
    }
  ' "$file")"
  trim_quotes "$raw"
}

env_from_lines() {
  local key="$1"
  awk -v wanted="$key" '
    index($0, wanted "=") == 1 {
      sub(/^[^=]*=/, "", $0)
      print
      exit
    }
  '
}

load_cos_config() {
  require_file "$COS_ENV_FILE"

  COS_ENDPOINT="$(dotenv_value DAYTONA190_COS_ENDPOINT "$COS_ENV_FILE")"
  COS_REGION="$(dotenv_value DAYTONA190_COS_REGION "$COS_ENV_FILE")"
  COS_ACCESS_KEY="$(dotenv_value DAYTONA190_COS_SECRET_ID "$COS_ENV_FILE")"
  COS_SECRET_KEY="$(dotenv_value DAYTONA190_COS_SECRET_KEY "$COS_ENV_FILE")"
  COS_BUCKET="$(dotenv_value DAYTONA190_COS_BUCKET "$COS_ENV_FILE")"
  COS_PREFIX="$(dotenv_value DAYTONA190_COS_VOLUME_PREFIX "$COS_ENV_FILE")"
  COS_LAYOUT="single-bucket-prefix"

  [[ -n "$COS_ENDPOINT" ]] || die "DAYTONA190_COS_ENDPOINT is empty"
  [[ -n "$COS_REGION" ]] || die "DAYTONA190_COS_REGION is empty"
  [[ -n "$COS_ACCESS_KEY" ]] || die "DAYTONA190_COS_SECRET_ID is empty"
  [[ -n "$COS_SECRET_KEY" ]] || die "DAYTONA190_COS_SECRET_KEY is empty"
  [[ -n "$COS_BUCKET" ]] || die "DAYTONA190_COS_BUCKET is empty"
  [[ -n "$COS_PREFIX" ]] || die "DAYTONA190_COS_VOLUME_PREFIX is empty"
}

load_saved_minio_config() {
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    MINIO_ACCESS_KEY="$(dotenv_value DAYTONA190_LOCAL_MINIO_ACCESS_KEY "$LOCAL_ENV_FILE")"
    MINIO_SECRET_KEY="$(dotenv_value DAYTONA190_LOCAL_MINIO_SECRET_KEY "$LOCAL_ENV_FILE")"
    MINIO_REGION="$(dotenv_value DAYTONA190_LOCAL_MINIO_REGION "$LOCAL_ENV_FILE")"
  fi

  MINIO_REGION="${MINIO_REGION:-$COS_REGION}"
}

load_minio_credentials_from_container() {
  local lines user password
  lines="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$MINIO_CONTAINER" 2>/dev/null || true)"
  [[ -n "$lines" ]] || return 0

  user="$(printf '%s\n' "$lines" | env_from_lines MINIO_ROOT_USER)"
  password="$(printf '%s\n' "$lines" | env_from_lines MINIO_ROOT_PASSWORD)"
  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-$user}"
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-$password}"
}

prompt_minio_credentials() {
  if [[ -z "$MINIO_ACCESS_KEY" ]]; then
    read -r -p "MinIO root user [daytona-v190]: " MINIO_ACCESS_KEY
    MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-daytona-v190}"
  fi
  if [[ -z "$MINIO_SECRET_KEY" ]]; then
    read -r -s -p "MinIO root password: " MINIO_SECRET_KEY
    printf '\n'
  fi
  [[ -n "$MINIO_SECRET_KEY" ]] || die "MinIO root password is required"
  [[ "$MINIO_SECRET_KEY" != *$'\n'* ]] || die "MinIO password must not contain a newline"
  [[ "$MINIO_ACCESS_KEY" != *$'\n'* ]] || die "MinIO user must not contain a newline"
}

backup_managed_file() {
  local file="$1"
  local stamp="$2"
  if [[ -e "$file" ]]; then
    cp -p -- "$file" "$STATE_DIR/$(basename "$file").before-$stamp"
  fi
}

write_local_env() {
  local temp_file stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$STATE_DIR"
  backup_managed_file "$LOCAL_ENV_FILE" "$stamp"
  temp_file="$(mktemp "$STATE_DIR/local-env.XXXXXX")"
  chmod 0600 "$temp_file"
  {
    printf '# Managed by %s; do not commit this file.\n' "$(basename "$0")"
    printf 'DAYTONA190_LOCAL_MINIO_ACCESS_KEY=%s\n' "$MINIO_ACCESS_KEY"
    printf 'DAYTONA190_LOCAL_MINIO_SECRET_KEY=%s\n' "$MINIO_SECRET_KEY"
    printf 'DAYTONA190_LOCAL_MINIO_REGION=%s\n' "$MINIO_REGION"
    printf 'DAYTONA190_LOCAL_MINIO_BUCKET=%s\n' "$COS_BUCKET"
    printf 'DAYTONA190_LOCAL_MINIO_DOCKER_ENDPOINT=http://minio:9000\n'
  } >"$temp_file"
  mv -f -- "$temp_file" "$LOCAL_ENV_FILE"
  chmod 0600 "$LOCAL_ENV_FILE"
}

write_local_override() {
  local temp_file stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$STATE_DIR"
  backup_managed_file "$LOCAL_OVERRIDE" "$stamp"
  temp_file="$(mktemp "$STATE_DIR/local-override.XXXXXX")"
  chmod 0600 "$temp_file"
  cat >"$temp_file" <<'YAML'
services:
  minio:
    image: ${DAYTONA190_MINIO_IMAGE:-minio/minio:RELEASE.2025-04-22T22-12-26Z}
    environment:
      MINIO_ROOT_USER: ${DAYTONA190_LOCAL_MINIO_ACCESS_KEY:?missing local MinIO user}
      MINIO_ROOT_PASSWORD: ${DAYTONA190_LOCAL_MINIO_SECRET_KEY:?missing local MinIO password}
      MINIO_SITE_REGION: ${DAYTONA190_LOCAL_MINIO_REGION:?missing local MinIO region}
      MINIO_IDENTITY_STS_EXPIRY: 24h
    command: ["server", "/data", "--console-address", ":9001"]
    volumes:
      - /app/data/minio/data:/data
    networks:
      - daytona-network
    restart: unless-stopped

  api:
    environment:
      S3_ENDPOINT: ${DAYTONA190_LOCAL_MINIO_DOCKER_ENDPOINT:?missing local MinIO endpoint}
      S3_STS_ENDPOINT: ${DAYTONA190_LOCAL_MINIO_DOCKER_ENDPOINT:?missing local MinIO endpoint}/minio/v1/assume-role
      S3_REGION: ${DAYTONA190_LOCAL_MINIO_REGION:?missing local MinIO region}
      S3_ACCESS_KEY: ${DAYTONA190_LOCAL_MINIO_ACCESS_KEY:?missing local MinIO user}
      S3_SECRET_KEY: ${DAYTONA190_LOCAL_MINIO_SECRET_KEY:?missing local MinIO password}
      S3_VOLUME_LAYOUT: ${DAYTONA190_COS_VOLUME_LAYOUT:-single-bucket-prefix}
      S3_DEFAULT_BUCKET: ${DAYTONA190_LOCAL_MINIO_BUCKET:?missing local MinIO bucket}
      S3_VOLUME_PREFIX: ${DAYTONA190_COS_VOLUME_PREFIX:?missing volume prefix}
      S3_FORCE_PATH_STYLE: "true"
      S3_STS_PROVIDER: minio
      S3_ACCOUNT_ID: /
      S3_ROLE_NAME: /

  runner:
    environment:
      AWS_ENDPOINT_URL: ${DAYTONA190_LOCAL_MINIO_DOCKER_ENDPOINT:?missing local MinIO endpoint}
      AWS_REGION: ${DAYTONA190_LOCAL_MINIO_REGION:?missing local MinIO region}
      AWS_ACCESS_KEY_ID: ${DAYTONA190_LOCAL_MINIO_ACCESS_KEY:?missing local MinIO user}
      AWS_SECRET_ACCESS_KEY: ${DAYTONA190_LOCAL_MINIO_SECRET_KEY:?missing local MinIO password}
      AWS_VOLUME_LAYOUT: ${DAYTONA190_COS_VOLUME_LAYOUT:-single-bucket-prefix}
      AWS_DEFAULT_BUCKET: ${DAYTONA190_LOCAL_MINIO_BUCKET:?missing local MinIO bucket}
      AWS_VOLUME_PREFIX: ${DAYTONA190_COS_VOLUME_PREFIX:?missing volume prefix}
YAML
  mv -f -- "$temp_file" "$LOCAL_OVERRIDE"
  chmod 0644 "$LOCAL_OVERRIDE"
}

compose_args() {
  COMPOSE_ARGS=(
    docker compose
    --project-name "$PROJECT"
    --project-directory "$COMPOSE_DIR"
    --env-file "$ENV_FILE"
    --env-file "$COS_ENV_FILE"
  )
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    COMPOSE_ARGS+=(--env-file "$LOCAL_ENV_FILE")
  fi
  COMPOSE_ARGS+=(
    -f "$BASE_COMPOSE"
    -f "$SITE_OVERRIDE"
    -f "$IMAGES_OVERRIDE"
  )
}

compose_cos() {
  compose_args
  "${COMPOSE_ARGS[@]}" -f "$COS_OVERRIDE" "$@"
}

compose_local() {
  compose_args
  "${COMPOSE_ARGS[@]}" -f "$COS_OVERRIDE" -f "$LOCAL_OVERRIDE" "$@"
}

ensure_compose_inputs() {
  require_file "$ENV_FILE"
  require_file "$COS_ENV_FILE"
  require_file "$BASE_COMPOSE"
  require_file "$SITE_OVERRIDE"
  require_file "$IMAGES_OVERRIDE"
  require_file "$COS_OVERRIDE"
}

ensure_local_config() {
  [[ -f "$LOCAL_ENV_FILE" ]] || die "run prepare first; missing $LOCAL_ENV_FILE"
  [[ -f "$LOCAL_OVERRIDE" ]] || die "run prepare first; missing $LOCAL_OVERRIDE"
  chmod 0600 "$LOCAL_ENV_FILE"
  chmod 0644 "$LOCAL_OVERRIDE"
}

validate_local_config() {
  compose_local config --quiet >/dev/null || die "local MinIO Compose configuration is invalid"
}

validate_cos_config() {
  compose_cos config --quiet >/dev/null || die "current COS Compose configuration is invalid"
}

print_disk_status() {
  local line
  line="$(df -hP "$MINIO_DATA_DIR" 2>/dev/null | tail -n 1 || true)"
  if [[ -n "$line" ]]; then
    log "MinIO disk: $line"
  else
    warn "cannot inspect disk usage for $MINIO_DATA_DIR"
  fi
}

container_status() {
  local container="$1"
  local state health
  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf '%s=missing\n' "$container"
    return 0
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$container")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
  printf '%s=%s health=%s\n' "$container" "$state" "$health"
}

plan() {
  ensure_compose_inputs
  load_cos_config
  validate_cos_config
  log "script version: $SCRIPT_VERSION"
  log "project: $PROJECT"
  log "compose directory: $COMPOSE_DIR"
  log "COS endpoint: $(printf '%s' "$COS_ENDPOINT" | sed -E 's#(https?://[^/]+).*#\1#')"
  log "COS bucket: $COS_BUCKET"
  log "COS layout: $COS_LAYOUT"
  log "COS volume prefix: $COS_PREFIX"
  log "local MinIO data: $MINIO_DATA_DIR"
  [[ -d "$MINIO_DATA_DIR" ]] || warn "MinIO data directory does not exist yet"
  print_disk_status
  container_status "$MINIO_CONTAINER"
  container_status "$API_CONTAINER"
  container_status "$RUNNER_CONTAINER"
  if [[ -f "$STATE_DIR/mode" ]]; then
    log "saved mode: $(cat "$STATE_DIR/mode")"
  else
    log "saved mode: no cutover state"
  fi
  log "no changes were made"
}

select_mc_mode() {
  if command -v mc >/dev/null 2>&1; then
    MC_MODE="host"
    local host_ip host_port
    host_ip="${MINIO_HOST_IP:-$(hostname -I 2>/dev/null | awk '{print $1}') }"
    host_ip="$(printf '%s' "$host_ip" | sed 's/[[:space:]]*$//')"
    host_port="${MINIO_HOST_PORT:-19000}"
    [[ -n "$host_ip" ]] || die "cannot determine host IP for local mc; set MINIO_HOST_IP"
    MINIO_MC_ENDPOINT="http://${host_ip}:${host_port}"
  else
    require_command docker
    MC_MODE="container"
    MINIO_MC_ENDPOINT="http://minio:9000"
    docker network inspect "${PROJECT}_daytona-network" >/dev/null 2>&1 \
      || die "Compose network ${PROJECT}_daytona-network is unavailable"
  fi
}

mc_run() {
  if [[ "$MC_MODE" == "host" ]]; then
    MC_CONFIG_DIR="$MC_CONFIG_DIR" mc "$@"
  else
    docker run --rm \
      --network "${PROJECT}_daytona-network" \
      --volume "$MC_CONFIG_DIR:/tmp/.mc:rw" \
      -e MC_CONFIG_DIR=/tmp/.mc \
      "$MC_IMAGE" "$@"
  fi
}

start_local_minio() {
  log "starting local MinIO only; API and Runner remain on COS"
  compose_local up -d minio
  wait_for_running "$MINIO_CONTAINER" 120
}

wait_for_running() {
  local container="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if docker inspect "$container" >/dev/null 2>&1; then
      local state
      state="$(docker inspect --format '{{.State.Status}}' "$container")"
      if [[ "$state" == "running" ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  docker logs --tail 80 "$container" >&2 2>/dev/null || true
  die "$container did not become running within ${timeout_seconds}s"
}

wait_for_healthy() {
  local container="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if docker inspect "$container" >/dev/null 2>&1; then
      local state health
      state="$(docker inspect --format '{{.State.Status}}' "$container")"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
      if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  docker logs --tail 120 "$container" >&2 2>/dev/null || true
  die "$container did not become healthy within ${timeout_seconds}s"
}

sync_cos_to_minio() {
  local temp_config
  select_mc_mode
  temp_config="$STATE_DIR/mc-config-$$"
  MC_CONFIG_DIR="$temp_config"
  install -d -m 0700 "$MC_CONFIG_DIR"

  log "checking source COS bucket and local MinIO bucket"
  mc_run alias set cos "$COS_ENDPOINT" "$COS_ACCESS_KEY" "$COS_SECRET_KEY" --api S3v4 >/dev/null
  mc_run alias set local "$MINIO_MC_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4 >/dev/null
  mc_run ls "cos/$COS_BUCKET" >/dev/null
  mc_run mb --ignore-existing "local/$COS_BUCKET" >/dev/null

  log "mirroring the complete COS bucket into local MinIO; existing local objects are preserved"
  mc_run mirror --overwrite --preserve "cos/$COS_BUCKET" "local/$COS_BUCKET"
  log "COS to local MinIO mirror completed"

  rm -rf -- "$MC_CONFIG_DIR"
  MC_CONFIG_DIR=""
}

initialize_empty_local_bucket() {
  local temp_config
  select_mc_mode
  temp_config="$STATE_DIR/mc-config-$$"
  MC_CONFIG_DIR="$temp_config"
  install -d -m 0700 "$MC_CONFIG_DIR"

  log "creating empty local MinIO bucket: $COS_BUCKET"
  mc_run alias set local "$MINIO_MC_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4 >/dev/null
  mc_run mb --ignore-existing "local/$COS_BUCKET" >/dev/null
  rm -rf -- "$MC_CONFIG_DIR"
  MC_CONFIG_DIR=""
}

stop_minio_for_reset() {
  local state
  if ! docker inspect "$MINIO_CONTAINER" >/dev/null 2>&1; then
    return 0
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$MINIO_CONTAINER")"
  if [[ "$state" == "running" ]]; then
    log "stopping existing MinIO before clearing its data"
    docker stop --time 30 "$MINIO_CONTAINER" >/dev/null
  fi
}

clear_minio_data() {
  [[ "$MINIO_DATA_DIR" == "/app/data/minio/data" ]] || die "refusing unexpected MinIO data path"
  install -d -m 0750 "$MINIO_DATA_DIR"
  log "clearing all objects from $MINIO_DATA_DIR"
  find "$MINIO_DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

write_marker() {
  local marker="$1"
  install -d -m 0700 "$STATE_DIR"
  printf '%s\n' "$marker" >"$STATE_DIR/$marker"
  printf '%s\n' "$marker" >"$STATE_DIR/mode"
  chmod 0600 "$STATE_DIR/$marker" "$STATE_DIR/mode"
}

prepare() {
  ensure_compose_inputs
  load_cos_config
  load_saved_minio_config
  load_minio_credentials_from_container
  prompt_minio_credentials
  [[ "$COS_LAYOUT" == "single-bucket-prefix" ]] \
    || die "unexpected COS layout: $COS_LAYOUT"
  [[ -d "$MINIO_DATA_DIR" ]] || install -d -m 0750 "$MINIO_DATA_DIR"
  install -d -m 0700 "$STATE_DIR"
  write_local_env
  write_local_override
  validate_local_config
  start_local_minio
  sync_cos_to_minio
  write_marker prepared
  log "prepare completed"
  log "API and Runner are still using COS"
  log "run cutover with confirmation during the approved maintenance window"
}

require_prepared() {
  ensure_local_config
  [[ -f "$STATE_DIR/prepared" ]] || die "prepare has not completed"
}

cutover() {
  [[ "$CONFIRMATION" == "$APPLY_CONFIRMATION" ]] || {
    usage
  }
  ensure_compose_inputs
  require_prepared
  load_cos_config
  load_saved_minio_config
  [[ -n "$MINIO_ACCESS_KEY" && -n "$MINIO_SECRET_KEY" ]] \
    || die "saved MinIO credentials are incomplete"
  validate_local_config
  install -d -m 0700 "$STATE_DIR"
  printf '%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$STATE_DIR/cutover-started-at"
  chmod 0600 "$STATE_DIR/cutover-started-at"

  log "stopping API and Runner for the final no-write mirror"
  compose_cos stop api runner
  sync_cos_to_minio

  log "recreating API and Runner with local MinIO storage"
  compose_local up -d minio api runner
  wait_for_healthy "$API_CONTAINER" 240
  wait_for_healthy "$RUNNER_CONTAINER" 240
  write_marker local
  log "cutover completed; API and Runner now use local MinIO"
  log "COS data was not deleted"
}

fresh_cutover() {
  [[ "$CONFIRMATION" == "$FRESH_CONFIRMATION" ]] || {
    usage
  }
  ensure_compose_inputs
  load_cos_config
  load_saved_minio_config
  load_minio_credentials_from_container
  prompt_minio_credentials
  [[ "$COS_LAYOUT" == "single-bucket-prefix" ]] \
    || die "unexpected COS layout: $COS_LAYOUT"
  if [[ -f "$STATE_DIR/mode" ]]; then
    case "$(cat "$STATE_DIR/mode")" in
      local|local-empty)
        die "storage is already in local mode; refusing to clear local MinIO data"
        ;;
    esac
  fi

  install -d -m 0700 "$STATE_DIR"
  printf '%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$STATE_DIR/fresh-cutover-started-at"
  chmod 0600 "$STATE_DIR/fresh-cutover-started-at"
  write_local_env
  write_local_override
  validate_cos_config
  validate_local_config

  stop_minio_for_reset
  clear_minio_data
  start_local_minio
  initialize_empty_local_bucket

  log "stopping API and Runner for the storage switch"
  compose_cos stop api runner
  log "recreating API and Runner with empty local MinIO storage"
  compose_local up -d minio api runner
  wait_for_healthy "$API_CONTAINER" 240
  wait_for_healthy "$RUNNER_CONTAINER" 240
  write_marker local-empty
  log "fresh cutover completed; API and Runner now use empty local MinIO"
  log "COS data was not read, synchronized, or deleted"
}

rollback() {
  [[ "$CONFIRMATION" == "$ROLLBACK_CONFIRMATION" ]] || {
    usage
  }
  ensure_compose_inputs
  ensure_local_config
  validate_cos_config
  install -d -m 0700 "$STATE_DIR"
  printf '%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$STATE_DIR/rollback-started-at"
  chmod 0600 "$STATE_DIR/rollback-started-at"

  log "recreating API and Runner with the original COS override"
  compose_cos up -d api runner
  wait_for_healthy "$API_CONTAINER" 240
  wait_for_healthy "$RUNNER_CONTAINER" 240
  write_marker rolled-back
  log "rollback completed; local MinIO data was preserved"
}

status() {
  ensure_compose_inputs
  if [[ -f "$STATE_DIR/mode" ]]; then
    log "saved mode: $(cat "$STATE_DIR/mode")"
  else
    log "saved mode: no cutover state"
  fi
  [[ -f "$LOCAL_ENV_FILE" ]] && log "local env: present (credentials hidden)" || log "local env: absent"
  [[ -f "$LOCAL_OVERRIDE" ]] && log "local Compose override: present" || log "local Compose override: absent"
  print_disk_status
  container_status "$MINIO_CONTAINER"
  container_status "$API_CONTAINER"
  container_status "$RUNNER_CONTAINER"
}

cleanup() {
  local status_code=$?
  trap - EXIT INT TERM RETURN
  if [[ "$LOCK_HELD" == "yes" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if [[ -n "$MC_CONFIG_DIR" ]]; then
    rm -rf -- "$MC_CONFIG_DIR"
  fi
  exit "$status_code"
}

main() {
  require_root
  require_command awk
  require_command cat
  require_command chmod
  require_command cp
  require_command date
  require_command df
  require_command docker
  require_command find
  require_command hostname
  require_command install
  require_command mktemp
  require_command mv
  require_command rm
  require_command sed
  require_command sleep

  case "$MODE" in
    plan|status)
      "$MODE"
      ;;
    prepare|cutover|fresh-cutover|rollback)
      install -d -m 0700 "$STATE_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || die "another operation is using $STATE_DIR"
      LOCK_HELD="yes"
      if [[ "$MODE" == "fresh-cutover" ]]; then
        fresh_cutover
      else
        "$MODE"
      fi
      ;;
    *)
      usage
      ;;
  esac
}

trap cleanup EXIT INT TERM
main "$@"
