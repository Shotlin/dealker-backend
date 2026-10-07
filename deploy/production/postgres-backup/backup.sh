#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "${BACKUP_DIR}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="${PGDATABASE}_${timestamp}.dump"
filepath="${BACKUP_DIR}/${filename}"
s3_key="${BACKUP_S3_PREFIX%/}/${filename}"

echo "[backup] creating ${filepath}"
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --host "${PGHOST}" \
  --port "${PGPORT}" \
  --username "${PGUSER}" \
  --dbname "${PGDATABASE}" \
  --file "${filepath}"

echo "[backup] uploading s3://${BACKUP_S3_BUCKET}/${s3_key}"
aws s3 cp \
  "${filepath}" \
  "s3://${BACKUP_S3_BUCKET}/${s3_key}" \
  --sse AES256

find "${BACKUP_DIR}" -type f -name "${PGDATABASE}_*.dump" -mtime +"${BACKUP_RETENTION_DAYS}" -delete

cutoff_epoch="$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%s)"
aws s3api list-objects-v2 \
  --bucket "${BACKUP_S3_BUCKET}" \
  --prefix "${BACKUP_S3_PREFIX%/}/" \
  --query 'Contents[].[Key,LastModified]' \
  --output text 2>/dev/null | while read -r key modified; do
    [ -n "${key:-}" ] || continue
    modified_epoch="$(date -u -d "${modified}" +%s 2>/dev/null || true)"
    if [ -n "${modified_epoch}" ] && [ "${modified_epoch}" -lt "${cutoff_epoch}" ]; then
      echo "[backup] deleting expired s3://${BACKUP_S3_BUCKET}/${key}"
      aws s3 rm "s3://${BACKUP_S3_BUCKET}/${key}"
    fi
  done

echo "[backup] completed ${filename}"
