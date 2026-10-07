#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

DUMP_PATH="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
INFRA_ENV_FILE="${INFRA_ENV_FILE:-deploy/production/infra.env}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"

read_env_value() {
  local key="$1"
  local value

  value="$(grep -E "^${key}=" "${INFRA_ENV_FILE}" | head -n 1 | cut -d= -f2-)"
  if [ -z "${value}" ]; then
    echo "Missing ${key} in ${INFRA_ENV_FILE}" >&2
    exit 1
  fi

  printf '%s' "${value}"
}

if [ -z "${DUMP_PATH}" ] || [ ! -f "${DUMP_PATH}" ]; then
  echo "Usage: ./deploy/production/restore-db.sh /path/to/dump.dump"
  exit 1
fi

POSTGRES_DB="$(read_env_value POSTGRES_DB)"
POSTGRES_USER="$(read_env_value POSTGRES_USER)"

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" up -d postgres
cat "${DUMP_PATH}" | docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_restore \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}"

if [ "${RUN_MIGRATIONS}" = "true" ]; then
  docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" run --rm migrate
fi
