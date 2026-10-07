#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
INFRA_ENV_FILE="${INFRA_ENV_FILE:-deploy/production/infra.env}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://bakaloo.shotlin.in}"

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" exec -T api wget -qO- http://localhost:3000/health/ready
docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" exec -T nginx wget -qO- http://localhost:8080/health/ready
curl -fsSL "${PUBLIC_BASE_URL}/health/ready"
