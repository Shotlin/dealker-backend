#!/usr/bin/env bash
# Routine production deploy — pulls whatever is on GitHub `origin/main` and
# ships it. Run this ON THE EC2 SERVER (after SSHing in), any time you've
# pushed backend changes and want them live. It is the exact procedure
# CLAUDE.md §14.1 documents, done by hand for every deploy this project has
# had so far — this script is that same sequence, made repeatable.
#
# Usage (from the server, as the `ubuntu` user):
#   cd /opt/bakaloo/app && ./deploy/production/routine-deploy.sh
#
# What it does, in order:
#   1. Shows what's about to change (current SHA vs. origin/main).
#   2. Takes a pg_dump backup and tags the current images for rollback.
#   3. Checks out origin/main, builds, runs migrations, restarts services.
#   4. Verifies: all containers healthy, source hash matches on disk vs.
#      containers, /health/ready, a couple of public smoke endpoints, and
#      scans the last 5 minutes of logs for real errors.
#
# Safe to re-run: build/migrate/up are all idempotent. It refuses to run
# if the working tree has local changes it didn't make itself (never
# discards real uncommitted work).
set -euo pipefail

APP_DIR="/opt/bakaloo/app"
COMPOSE="sudo docker compose --env-file deploy/production/infra.env -f docker-compose.prod.yml"
BACKUP_DIR="/srv/bakaloo/backups"
HEALTH_URL="https://api.fc.opslin.com/health/ready"

cd "${APP_DIR}"

echo "=== Pre-flight ==="
sudo -u bakalooops git fetch origin main
CURRENT_SHA=$(sudo -u bakalooops git rev-parse --short HEAD)
TARGET_SHA=$(sudo -u bakalooops git rev-parse --short origin/main)
if [ "${CURRENT_SHA}" = "${TARGET_SHA}" ]; then
  echo "Already at origin/main (${CURRENT_SHA}) — nothing to deploy."
  exit 0
fi
echo "Deploying ${CURRENT_SHA} -> ${TARGET_SHA}"
sudo -u bakalooops git log --oneline "${CURRENT_SHA}..${TARGET_SHA}"

DIRTY=$(sudo -u bakalooops git status --porcelain -- . ':!deploy/production/app.env' ':!deploy/production/infra.env')
if [ -n "${DIRTY}" ]; then
  echo "Refusing to deploy: the server checkout has local changes that aren't app.env/infra.env:"
  echo "${DIRTY}"
  exit 1
fi

echo "=== Backup (best-effort — never blocks the deploy) ==="
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DUMP_FILE="${BACKUP_DIR}/pre-deploy-${TARGET_SHA}-${TIMESTAMP}.dump"
if sudo docker exec freshcuts-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' | sudo -u bakalooops tee "${DUMP_FILE}" >/dev/null; then
  sudo chmod 600 "${DUMP_FILE}"
  echo "Backup: ${DUMP_FILE}"
else
  echo "WARNING: backup failed — continuing anyway (fix this if it keeps happening)."
fi

for svc in api worker migrate; do
  sudo docker tag "freshcuts-${svc}:latest" "freshcuts-${svc}:rollback-pre-${TARGET_SHA}" 2>/dev/null || true
done

echo "=== Cleanup (keep 2 newest rollback tags per service + 5 newest DB dumps) ==="
for svc in api worker migrate; do
  sudo docker images "freshcuts-${svc}" --format '{{.CreatedAt}}|{{.Tag}}' \
    | grep '|rollback-pre-' | sort -r | tail -n +3 | cut -d'|' -f2 \
    | xargs -r -I{} sudo docker rmi "freshcuts-${svc}:{}" >/dev/null 2>&1 || true
done
sudo docker image prune -f >/dev/null 2>&1 || true
sudo docker builder prune -af >/dev/null 2>&1 || true
sudo ls -1t "${BACKUP_DIR}"/pre-deploy-*.dump 2>/dev/null | tail -n +6 | xargs -r sudo rm -f || true
df -h / | tail -1

echo "=== Deploy ==="
sudo -u bakalooops git checkout -f -B main origin/main
${COMPOSE} build api worker migrate
${COMPOSE} run --rm migrate
${COMPOSE} up -d api worker nginx
${COMPOSE} restart nginx

echo "=== Verify ==="
sleep 8
${COMPOSE} ps

echo "--- source hash: disk vs containers ---"
DISK_HASH=$(find src -type f | sort | xargs sha1sum | sha1sum)
API_HASH=$(sudo docker exec freshcuts-api-1 sh -c 'cd /app && find src -type f | sort | xargs sha1sum | sha1sum')
WORKER_HASH=$(sudo docker exec freshcuts-worker-1 sh -c 'cd /app && find src -type f | sort | xargs sha1sum | sha1sum')
echo "disk:   ${DISK_HASH}"
echo "api:    ${API_HASH}"
echo "worker: ${WORKER_HASH}"
if [ "${DISK_HASH}" != "${API_HASH}" ] || [ "${DISK_HASH}" != "${WORKER_HASH}" ]; then
  echo "WARNING: source hash mismatch — containers may be stale. Investigate before trusting this deploy."
fi

echo "--- health ---"
curl -fsS "${HEALTH_URL}" && echo

echo "--- public smoke ---"
curl -s -o /dev/null -w "products: %{http_code}\n" "https://api.fc.opslin.com/api/v1/products?limit=1"
curl -s -o /dev/null -w "categories: %{http_code}\n" "https://api.fc.opslin.com/api/v1/categories"

echo "--- error scan (last 5 min) ---"
${COMPOSE} logs --since 5m api worker 2>&1 | grep -iE "error|exception|fatal" | grep -v "401\|ACCOUNT_BLOCKED\|VALIDATION_ERROR" || echo "(none found)"

echo "=== Done: ${CURRENT_SHA} -> ${TARGET_SHA} ==="
echo "Rollback if needed: sudo -u bakalooops git checkout -f -B main ${CURRENT_SHA} && rebuild, or use images tagged rollback-pre-${TARGET_SHA}"
