#!/usr/bin/env bash
# Ships the current local backend source to the FreshCuts EC2 production
# host and redeploys it. Run this from a Mac that has the SSH key and the
# local repo checked out — this is the "update production" button.
#
# Usage: ./deploy/production/redeploy-from-local.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

SSH_KEY="${SSH_KEY:-/Users/sayan/Downloads/Freshcuts.pem}"
EC2_HOST="${EC2_HOST:-ec2-13-127-81-17.ap-south-1.compute.amazonaws.com}"
EC2_USER="${EC2_USER:-bakalooops}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/bakaloo/app}"
COMPOSE_FILE="docker-compose.prod.yml"
INFRA_ENV_FILE="deploy/production/infra.env"

echo "==> Syncing source to ${EC2_USER}@${EC2_HOST}:${REMOTE_APP_DIR}"
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.env' --exclude '.env.*' \
  --exclude 'logs' --exclude '*.log' \
  --exclude 'coverage' --exclude 'dist' --exclude 'build' \
  --exclude '.DS_Store' --exclude '.git' \
  --exclude 'scratch' \
  --exclude 'deploy/production/app.env' --exclude 'deploy/production/infra.env' \
  -e "ssh -i ${SSH_KEY}" \
  "${ROOT_DIR}/" "${EC2_USER}@${EC2_HOST}:${REMOTE_APP_DIR}/"

echo "==> Rebuilding images on the server"
ssh -i "${SSH_KEY}" "${EC2_USER}@${EC2_HOST}" \
  "cd ${REMOTE_APP_DIR} && docker compose --env-file ${INFRA_ENV_FILE} -f ${COMPOSE_FILE} build api worker migrate"

echo "==> Running migrations"
ssh -i "${SSH_KEY}" "${EC2_USER}@${EC2_HOST}" \
  "cd ${REMOTE_APP_DIR} && docker compose --env-file ${INFRA_ENV_FILE} -f ${COMPOSE_FILE} run --rm migrate"

echo "==> Recreating api, worker, nginx"
ssh -i "${SSH_KEY}" "${EC2_USER}@${EC2_HOST}" \
  "cd ${REMOTE_APP_DIR} && docker compose --env-file ${INFRA_ENV_FILE} -f ${COMPOSE_FILE} up -d api worker nginx"

echo "==> Restarting nginx (re-resolves the api/worker container IPs)"
ssh -i "${SSH_KEY}" "${EC2_USER}@${EC2_HOST}" \
  "cd ${REMOTE_APP_DIR} && docker compose --env-file ${INFRA_ENV_FILE} -f ${COMPOSE_FILE} restart nginx"

sleep 8
echo "==> Smoke test"
curl -fsS "https://api.fc.opslin.com/health/ready" && echo
echo "==> Done"
