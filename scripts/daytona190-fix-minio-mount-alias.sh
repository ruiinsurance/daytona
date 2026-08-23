#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Add the bucket-style DNS alias needed by the COS-oriented mount-s3 wrapper
# when the Daytona Runner points at the local MinIO service.

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
readonly LOCK_DIR="${STATE_DIR}/.minio-alias.lock"
readonly MINIO_CONTAINER="${PROJECT}-minio-1"
readonly RUNNER_CONTAINER="${PROJECT}-runner-1"
readonly MINIO_NETWORK="${PROJECT}_daytona-network"
readonly MINIO_HOST_PORT="19000"

MODE="${1:-apply}"
LOCK_HELD="no"
BUCKET=""
ALIAS=""

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[daytona190-minio-alias] %s\n' "$*"
}

warn() {
  printf '[daytona190-minio-alias] warning: %s\n' "$*" >&2
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo bash /tmp/daytona190-fix-minio-mount-alias.sh apply
  sudo bash /tmp/daytona190-fix-minio-mount-alias.sh check

apply  Add the bucket-style MinIO network alias and recreate MinIO only.
check  Verify the alias, MinIO health, and Runner DNS resolution without changes.

The script does not modify COS, API, Runner, or MinIO objects.
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

  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$raw" == '"'*'"' || "$raw" == "'*'" ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

load_config() {
  require_file "$ENV_FILE"
  require_file "$COS_ENV_FILE"
  require_file "$BASE_COMPOSE"
  require_file "$SITE_OVERRIDE"
  require_file "$IMAGES_OVERRIDE"
  require_file "$COS_OVERRIDE"
  require_file "$LOCAL_ENV_FILE"
  require_file "$LOCAL_OVERRIDE"

  BUCKET="$(dotenv_value DAYTONA190_LOCAL_MINIO_BUCKET "$LOCAL_ENV_FILE")"
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
    || die "invalid local MinIO bucket name: $BUCKET"
  ALIAS="${BUCKET}.minio"
}

compose_args() {
  COMPOSE_ARGS=(
    docker compose
    --project-name "$PROJECT"
    --project-directory "$COMPOSE_DIR"
    --env-file "$ENV_FILE"
    --env-file "$COS_ENV_FILE"
    --env-file "$LOCAL_ENV_FILE"
    -f "$BASE_COMPOSE"
    -f "$SITE_OVERRIDE"
    -f "$IMAGES_OVERRIDE"
    -f "$COS_OVERRIDE"
    -f "$LOCAL_OVERRIDE"
  )
}

compose_local() {
  compose_args
  "${COMPOSE_ARGS[@]}" "$@"
}

backup_override() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$STATE_DIR"
  cp -p -- "$LOCAL_OVERRIDE" "$STATE_DIR/$(basename "$LOCAL_OVERRIDE").before-alias-$stamp"
}

patch_override() {
  local temp_file
  local alias_present="no"
  local domain_present="no"

  if grep -Fqx -- "          - $ALIAS" "$LOCAL_OVERRIDE"; then
    alias_present="yes"
  fi

  if grep -Eq '^[[:space:]]*MINIO_DOMAIN:' "$LOCAL_OVERRIDE"; then
    if ! grep -Eq '^      MINIO_DOMAIN:[[:space:]]*minio[[:space:]]*$' "$LOCAL_OVERRIDE"; then
      die "MINIO_DOMAIN is already configured with an unexpected value in $LOCAL_OVERRIDE"
    fi
    domain_present="yes"
  fi

  if [[ "$alias_present" == "yes" && "$domain_present" == "yes" ]]; then
    log "MinIO network alias already present: $ALIAS"
    log "MinIO virtual-host domain already present: minio"
    return 0
  fi

  backup_override

  if [[ "$alias_present" == "no" ]]; then
    temp_file="$(mktemp "$STATE_DIR/local-override.XXXXXX")"
    chmod 0600 "$temp_file"
    if ! awk -v alias="$ALIAS" '
      BEGIN { patched = 0 }
      {
        if (!patched && $0 == "    networks:") {
          print
          if ((getline next_line) <= 0) exit 3
          if (next_line != "      - daytona-network") {
            print next_line
            next
          }
          print "      daytona-network:"
          print "        aliases:"
          print "          - " alias
          patched = 1
          next
        }
        print
      }
      END {
        if (!patched) exit 4
      }
    ' "$LOCAL_OVERRIDE" >"$temp_file"; then
      rm -f -- "$temp_file"
      die "could not find the generated MinIO network block in $LOCAL_OVERRIDE"
    fi

    mv -f -- "$temp_file" "$LOCAL_OVERRIDE"
    chmod 0644 "$LOCAL_OVERRIDE"
    log "added MinIO network alias: $ALIAS"
  else
    log "MinIO network alias already present: $ALIAS"
  fi

  if [[ "$domain_present" == "no" ]]; then
    temp_file="$(mktemp "$STATE_DIR/local-override.XXXXXX")"
    chmod 0600 "$temp_file"
    if ! awk '
      BEGIN {
        in_minio = 0
        in_environment = 0
        patched = 0
      }
      $0 == "  minio:" {
        in_minio = 1
        in_environment = 0
      }
      in_minio && $0 ~ /^  [^[:space:]][^:]*:/ && $0 != "  minio:" {
        in_minio = 0
        in_environment = 0
      }
      in_minio && $0 == "    environment:" {
        in_environment = 1
        print
        next
      }
      in_minio && in_environment && $0 ~ /^      MINIO_SITE_REGION:/ {
        print
        print "      MINIO_DOMAIN: minio"
        patched = 1
        next
      }
      in_minio && in_environment && $0 == "    command:" {
        print "      MINIO_DOMAIN: minio"
        patched = 1
        in_environment = 0
      }
      {
        print
      }
      END {
        if (!patched) exit 4
      }
    ' "$LOCAL_OVERRIDE" >"$temp_file"; then
      rm -f -- "$temp_file"
      die "could not add MINIO_DOMAIN to the generated MinIO environment in $LOCAL_OVERRIDE"
    fi

    mv -f -- "$temp_file" "$LOCAL_OVERRIDE"
    chmod 0644 "$LOCAL_OVERRIDE"
    log "added MinIO virtual-host domain: minio"
  fi
}

wait_for_running() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if docker inspect "$MINIO_CONTAINER" >/dev/null 2>&1; then
      if [[ "$(docker inspect --format '{{.State.Status}}' "$MINIO_CONTAINER")" == "running" ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  docker inspect "$MINIO_CONTAINER" >&2 2>/dev/null || true
  die "$MINIO_CONTAINER did not become running within 120s"
}

minio_host_ip() {
  local host_ip
  if [[ -n "${DAYTONA190_MINIO_HOST_IP:-}" ]]; then
    host_ip="$DAYTONA190_MINIO_HOST_IP"
  else
    # hostname -I can list an unrelated interface first. Read the address
    # Docker actually published for MinIO's S3 port instead.
    host_ip="$(docker port "$MINIO_CONTAINER" 9000/tcp 2>/dev/null | awk -F: 'NR == 1 {print $1}')"
  fi
  host_ip="$(printf '%s' "$host_ip" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -n "$host_ip" ]] || die "cannot determine MinIO published host IP; set DAYTONA190_MINIO_HOST_IP"
  printf '%s' "$host_ip"
}

verify_alias() {
  local aliases
  aliases="$(docker inspect --format '{{json (index .NetworkSettings.Networks "'"$MINIO_NETWORK"'").Aliases}}' "$MINIO_CONTAINER" 2>/dev/null || true)"
  [[ "$aliases" == *"\"$ALIAS\""* ]] \
    || die "MinIO container is missing network alias $ALIAS (aliases=$aliases)"
  log "Docker network alias verified: $ALIAS"
}

verify_minio_health() {
  local host_ip="$1"
  local deadline=$((SECONDS + 120))

  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 5 \
      "http://${host_ip}:${MINIO_HOST_PORT}/minio/health/live" >/dev/null 2>&1; then
      log "MinIO health endpoint verified"
      return 0
    fi
    sleep 2
  done

  die "MinIO health endpoint did not become ready within 120s"
}

verify_virtual_host() {
  local host_ip="$1"
  local http_status

  http_status="$(curl --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --max-time 5 \
    --header "Host: ${ALIAS}:9000" \
    "http://${host_ip}:${MINIO_HOST_PORT}/")" \
    || die "MinIO virtual-host request failed"

  [[ "$http_status" == "403" ]] \
    || die "MinIO virtual-host request returned HTTP $http_status; expected 403 for an unsigned existing bucket"
  log "MinIO virtual-host request verified for $ALIAS"
}

verify_runner_dns() {
  local output status
  if ! docker inspect "$RUNNER_CONTAINER" >/dev/null 2>&1; then
    warn "Runner container is missing; skipped Runner DNS verification"
    return 0
  fi

  if output="$(docker exec "$RUNNER_CONTAINER" sh -c \
    'command -v getent >/dev/null 2>&1 || exit 127; getent hosts "$1"' sh "$ALIAS" 2>/dev/null)"; then
    log "Runner resolves $ALIAS: $output"
    return 0
  fi
  status=$?
  if (( status == 127 )); then
    warn "Runner image has no getent; skipped in-container DNS verification"
  else
    die "Runner cannot resolve $ALIAS"
  fi
}

check() {
  load_config
  verify_alias
  wait_for_running
  local host_ip="$(minio_host_ip)"
  verify_minio_health "$host_ip"
  verify_virtual_host "$host_ip"
  verify_runner_dns
  log "MinIO bucket-style mount check passed"
}

apply() {
  load_config
  patch_override
  compose_local config --quiet >/dev/null || die "local Compose configuration is invalid"
  log "recreating MinIO only with the bucket-style alias; API and Runner are untouched"
  compose_local up -d --no-deps --force-recreate minio
  wait_for_running
  verify_alias
  local host_ip="$(minio_host_ip)"
  verify_minio_health "$host_ip"
  verify_virtual_host "$host_ip"
  verify_runner_dns
  install -d -m 0700 "$STATE_DIR"
  printf '%s\n' "$ALIAS" >"$STATE_DIR/minio-network-alias"
  chmod 0600 "$STATE_DIR/minio-network-alias"
  log "MinIO bucket-style mount fix completed"
  log "create a new sandbox after this check; old sandbox volumes were discarded"
}

cleanup() {
  local status_code=$?
  trap - EXIT INT TERM RETURN
  if [[ "$LOCK_HELD" == "yes" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  exit "$status_code"
}

main() {
  require_root
  require_command awk
  require_command cat
  require_command chmod
  require_command cp
  require_command curl
  require_command date
  require_command docker
  require_command grep
  require_command install
  require_command mktemp
  require_command mv
  require_command rm
  require_command sed
  require_command sleep

  case "$MODE" in
    apply|check)
      install -d -m 0700 "$STATE_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || die "another MinIO alias operation is using $STATE_DIR"
      LOCK_HELD="yes"
      "$MODE"
      ;;
    *)
      usage
      ;;
  esac
}

trap cleanup EXIT INT TERM
main "$@"
