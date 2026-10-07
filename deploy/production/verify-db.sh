#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
INFRA_ENV_FILE="${INFRA_ENV_FILE:-deploy/production/infra.env}"

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

POSTGRES_DB="$(read_env_value POSTGRES_DB)"
POSTGRES_USER="$(read_env_value POSTGRES_USER)"

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" <<'SQL'
SELECT extname
FROM pg_extension
WHERE extname IN ('uuid-ossp', 'pg_trgm', 'pgcrypto')
ORDER BY extname;

SELECT 'users' AS table_name, COUNT(*) FROM users
UNION ALL
SELECT 'products', COUNT(*) FROM products
UNION ALL
SELECT 'orders', COUNT(*) FROM orders
UNION ALL
SELECT 'payments', COUNT(*) FROM payments
UNION ALL
SELECT 'wallet_transactions', COUNT(*) FROM wallet_transactions
UNION ALL
SELECT 'reviews', COUNT(*) FROM reviews
UNION ALL
SELECT 'theme_tabs', COUNT(*) FROM theme_tabs
ORDER BY table_name;
SQL
