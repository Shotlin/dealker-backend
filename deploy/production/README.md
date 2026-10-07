# Production Deployment

This directory contains the production deployment assets for the Bakaloo backend Docker stack on EC2.

## Files

- `routine-deploy.sh`: **the one to use for every normal deploy.** Run it on the EC2 server after pushing backend changes to GitHub — pulls `origin/main`, backs up the DB, builds, migrates, restarts, and verifies. See its own header comment for the exact usage and what it checks.
- `bootstrap-ec2.sh`: hardens Ubuntu, installs Docker, enables UFW/fail2ban, and creates the required directories. One-time — the server is already bootstrapped.
- `load-ssm-env.sh`: pulls secrets from AWS SSM Parameter Store and renders `app.env` and `infra.env`.
- `deploy.sh`: builds the application image, starts PostgreSQL and Redis, runs migrations, and starts the full stack.
- `restore-db.sh`: restores a PostgreSQL custom-format dump into the Dockerized production database and re-runs migrations.
- `verify-db.sh`: checks required extensions and row counts for critical tables.
- `smoke-test.sh`: validates the readiness endpoint internally and via the public hostname.
- `export-local-db.sh`: creates a local PostgreSQL custom-format dump from the developer Docker stack.
- `cloudflared/config.yml.example`: template for the dedicated backend tunnel configuration.
- `bakaloo-compose.service`: systemd unit for boot-time stack recovery.

## Deployment Order

1. Run `bootstrap-ec2.sh` on the EC2 host.
2. Clone the repo to `/opt/bakaloo/app`.
3. Populate SSM parameters and run `load-ssm-env.sh`.
4. Run `deploy.sh`.
5. Export local data with `export-local-db.sh`, copy it to the EC2 host, then run `restore-db.sh`.
6. Run `verify-db.sh`.
7. Run `smoke-test.sh`.
8. Install the tunnel credentials JSON and rendered `cloudflared/config.yml`.
9. Install `bakaloo-compose.service` under `/etc/systemd/system/`, then `systemctl enable --now bakaloo-compose`.

## Required SSM Parameters

Store application env keys under a single prefix such as `/bakaloo/backend/prod`.

- Application secrets: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `REDIS_PASSWORD`, `RAZORPAY_*`, `TWO_FACTOR_API_KEY`, optional Firebase/Cloudinary keys.
- Infra secrets: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `AWS_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_RETENTION_DAYS`, `BACKUP_SCHEDULE`.

## Notes

- Keep `ENABLE_SWAGGER=false` in production unless you front it with Cloudflare Access.
- `cloudflared` is the only public ingress path; do not publish ports from `docker-compose.prod.yml`.
- PostgreSQL state, Redis state, and backups are bind-mounted to `/srv/bakaloo/*`.
- `postgres-backup` is behind the `ops` profile and is only started when `ENABLE_BACKUPS=true` is passed to `deploy.sh`.
