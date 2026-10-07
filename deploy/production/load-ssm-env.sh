#!/usr/bin/env bash
set -euo pipefail

SSM_PARAMETER_PREFIX="${SSM_PARAMETER_PREFIX:-${1:-}}"
APP_ENV_PATH="${APP_ENV_PATH:-deploy/production/app.env}"
INFRA_ENV_PATH="${INFRA_ENV_PATH:-deploy/production/infra.env}"

if [ -z "${SSM_PARAMETER_PREFIX}" ]; then
  echo "Usage: SSM_PARAMETER_PREFIX=/bakaloo/backend/prod ./deploy/production/load-ssm-env.sh"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

declare -A params
while IFS=$'\t' read -r name value; do
  key="${name##*/}"
  params["${key}"]="${value}"
done < <(
  aws ssm get-parameters-by-path \
    --with-decryption \
    --recursive \
    --path "${SSM_PARAMETER_PREFIX}" \
    --query 'Parameters[].[Name,Value]' \
    --output text
)

mkdir -p "$(dirname "${APP_ENV_PATH}")"

declare -A infra_only_keys=(
  [AWS_REGION]=1
  [BACKUP_DIR]=1
  [BACKUP_RETENTION_DAYS]=1
  [BACKUP_S3_BUCKET]=1
  [BACKUP_S3_PREFIX]=1
  [BACKUP_SCHEDULE]=1
  [CLOUDFLARE_TUNNEL_TOKEN]=1
  [COMPOSE_PROJECT_NAME]=1
  [POSTGRES_DATA_DIR]=1
  [POSTGRES_DB]=1
  [POSTGRES_PASSWORD]=1
  [POSTGRES_USER]=1
  [REDIS_DATA_DIR]=1
  [TZ]=1
)

{
  for key in "${!params[@]}"; do
    if [ -n "${infra_only_keys[${key}]:-}" ]; then
      continue
    fi
    printf '%s=%s\n' "${key}" "${params[${key}]}"
  done | sort
} > "${APP_ENV_PATH}"

{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "${params[COMPOSE_PROJECT_NAME]:-bakaloo}"
  printf 'TZ=%s\n' "${params[TZ]:-Asia/Kolkata}"
  printf 'POSTGRES_DB=%s\n' "${params[POSTGRES_DB]:-${params[DB_NAME]:-grocery_db}}"
  printf 'POSTGRES_USER=%s\n' "${params[POSTGRES_USER]:-${params[DB_USER]:-grocery_user}}"
  printf 'POSTGRES_PASSWORD=%s\n' "${params[POSTGRES_PASSWORD]:-${params[DB_PASSWORD]:-}}"
  printf 'REDIS_PASSWORD=%s\n' "${params[REDIS_PASSWORD]:-}"
  printf 'POSTGRES_DATA_DIR=%s\n' "${params[POSTGRES_DATA_DIR]:-/srv/bakaloo/postgres}"
  printf 'REDIS_DATA_DIR=%s\n' "${params[REDIS_DATA_DIR]:-/srv/bakaloo/redis}"
  printf 'BACKUP_DIR=%s\n' "${params[BACKUP_DIR]:-/srv/bakaloo/backups}"
  printf 'AWS_REGION=%s\n' "${params[AWS_REGION]:-ap-south-1}"
  printf 'BACKUP_S3_BUCKET=%s\n' "${params[BACKUP_S3_BUCKET]:-}"
  printf 'BACKUP_S3_PREFIX=%s\n' "${params[BACKUP_S3_PREFIX]:-postgres}"
  printf 'BACKUP_RETENTION_DAYS=%s\n' "${params[BACKUP_RETENTION_DAYS]:-14}"
  printf 'BACKUP_SCHEDULE=%s\n' "${params[BACKUP_SCHEDULE]:-0 */6 * * *}"
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "${params[CLOUDFLARE_TUNNEL_TOKEN]:-}"
} > "${INFRA_ENV_PATH}"

chmod 600 "${APP_ENV_PATH}" "${INFRA_ENV_PATH}"
echo "Wrote ${APP_ENV_PATH} and ${INFRA_ENV_PATH}"
