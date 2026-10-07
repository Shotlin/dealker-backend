#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

OUTPUT_PATH="${1:-/tmp/bakaloo-local-$(date -u +%Y%m%dT%H%M%SZ).dump}"

docker compose up -d postgres >/dev/null
docker compose exec -T postgres pg_dump -U grocery_user -d grocery_db -Fc > "${OUTPUT_PATH}"

echo "Created ${OUTPUT_PATH}"
