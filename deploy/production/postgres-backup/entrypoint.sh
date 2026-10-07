#!/usr/bin/env bash
set -euo pipefail

BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 */6 * * *}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RUN_ON_STARTUP="${BACKUP_RUN_ON_STARTUP:-true}"

mkdir -p "${BACKUP_DIR}"

echo "${BACKUP_SCHEDULE} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "[backup] schedule=${BACKUP_SCHEDULE}"

if [ "${BACKUP_RUN_ON_STARTUP}" = "true" ]; then
  /usr/local/bin/backup.sh || echo "[backup] initial backup failed; cron will retry later"
fi

exec crond -f -l 2
