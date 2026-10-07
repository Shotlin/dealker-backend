# FreshCuts Backend — Production Deployment

Live at: **https://api.fc.opslin.com**
Dashboard (Vercel): **https://dash.fc.opslin.com** — allowed in `CORS_ORIGINS` and set as `ADMIN_URL` in `app.env`.

This file is the source of truth for how the backend is deployed. Keep it
up to date — the intent is that after any backend change, the redeploy
script below gets run and this file still accurately describes what's
running.

## Server

- **Host:** AWS EC2, `ec2-13-127-81-17.ap-south-1.compute.amazonaws.com` (ap-south-1 / Mumbai), Ubuntu 26.04
- **SSH key:** `/Users/sayan/Downloads/Freshcuts.pem` (keep this safe — it is the only way in)
- **Users:**
  - `ubuntu` — the AMI's default user, has passwordless `sudo`. Kept as a break-glass fallback.
  - `bakalooops` — the day-to-day deploy user. Has `sudo` (password-protected, so non-interactive scripts should use `ubuntu` for anything needing root) and is in the `docker` group. Owns `/opt/bakaloo/app` and `/srv/bakaloo/*`.
- **App code:** `/opt/bakaloo/app` (this repo, minus `node_modules`/`.env`/etc. — shipped by `rsync`, not `git clone`, since this repo has no git remote)
- **Data:** `/srv/bakaloo/postgres`, `/srv/bakaloo/redis`, `/srv/bakaloo/backups` (bind-mounted into the containers)

The `bakaloo` naming in paths/usernames is inherited from the reference
deployment tooling this was copied from — it's just internal Linux
plumbing with no user-facing meaning. `COMPOSE_PROJECT_NAME=freshcuts` is
what actually shows up in `docker ps`, container names, etc.

## Architecture

```
Internet
   |
   v
Host nginx (systemd, :80/:443) — Let's Encrypt TLS for api.fc.opslin.com
   |  proxies to 127.0.0.1:8080
   v
Docker: nginx (rate limiting, security headers) :8080
   |
   v
Docker: api (Fastify, :3000, internal only) ---> Docker: postgres, redis
Docker: worker (BullMQ jobs — orders, notifications, settlements, etc.)
```

- Everything except the host-level nginx + certbot runs in Docker via
  `docker-compose.prod.yml`, started as the `bakaloo-compose` systemd
  service (`systemctl status bakaloo-compose`) so it survives a reboot.
- The **Docker nginx** service is the one described in
  `deploy/production/README.md` and was originally designed to sit behind
  a Cloudflare Tunnel (`cloudflared`). That's *not* how this is deployed —
  the domain's DNS points directly at this box's public IP, so a
  **host-level nginx** (installed via `apt`, not Docker) terminates TLS
  and reverse-proxies to the Docker nginx on `127.0.0.1:8080`. The
  `cloudflared` service in the compose file is gated behind the `ops`
  Compose profile and is not running — it's inert, kept only in case a
  tunnel is wanted later.
- TLS cert: Let's Encrypt via `certbot --nginx`, auto-renews via the
  `certbot.timer` systemd timer. Current cert expires **2026-12-05**.
- Host nginx config: `/etc/nginx/sites-available/api.fc.opslin.com.conf`
  on the server (not tracked in this repo — it's server-local, three
  lines: proxy `/` to `127.0.0.1:8080`, plus what certbot appended for
  TLS).

## How to redeploy after a backend change

```bash
./deploy/production/redeploy-from-local.sh
```

Run this from a machine with the SSH key and this repo checked out (it
defaults to this Mac's key path and this EC2 host — override with the
`SSH_KEY`/`EC2_HOST`/`EC2_USER` env vars if that ever changes). It:

1. `rsync`s the local source to `/opt/bakaloo/app` (excludes
   `node_modules`, `.env*`, logs, etc. — same exclude list as `.gitignore`).
2. Rebuilds the `api`/`worker`/`migrate` Docker images on the server.
3. Runs `docker compose run --rm migrate` (idempotent — only applies new
   migrations).
4. Recreates `api`, `worker`, `nginx`.
5. Restarts the Docker `nginx` container. **This step matters**: nginx
   resolves the `api`/`worker` container IPs once at startup and does not
   re-resolve them, so after `api`/`worker` are recreated (new container
   IPs), nginx needs a restart or it'll serve 502s against the old IP.
6. Curls `https://api.fc.opslin.com/health/ready` as a smoke test.

If a deploy ever needs a fresh production data snapshot from local dev
(not a routine code update — this overwrites prod data), use
`export-local-db.sh` + `restore-db.sh` from `deploy/production/README.md`.

## Secrets

Live only on the server, at `/opt/bakaloo/app/deploy/production/{app.env,infra.env}`
(`chmod 600`, owned by `bakalooops`). Not committed anywhere, not in this
repo, not backed up anywhere else right now. If the server is ever
rebuilt, these need regenerating (JWT/cookie/DB/Redis secrets — safe to
generate fresh) or restoring from a password manager if you choose to
save a copy there.

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `DB_PASSWORD`,
`REDIS_PASSWORD` were freshly generated for production (not reused from
local dev). `CLOUDINARY_*` were carried over from local dev since it's
the same real Cloudinary account, not an environment-specific secret.

## What's intentionally NOT configured yet

These were already unconfigured in local dev too — this deploy didn't
remove anything, it just carried the same gaps into production. Fill
these in via `app.env` on the server + rebuild when ready:

- **Payments (Razorpay)** — `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` are blank. No live payment processing.
- **Real SMS OTP** — `SMS_PROVIDER=none`, `TWO_FACTOR_API_KEY` blank. `ALLOW_DEMO_OTP=true` is what's carrying login right now (see security note below).
- **Push notifications** — `FCM_ENABLED=false`, Firebase creds blank.
- **Automated DB backups** — the `postgres-backup` service exists in the compose file (behind the `ops` profile) but isn't running; `BACKUP_S3_BUCKET` is unset. **There is currently no automated backup of the production database.** Worth prioritizing before this holds real customer/order data.

## Security notes — read before opening this to real customers

- `ALLOW_DEMO_OTP=true` is currently set in production. This means the
  demo phone numbers (`9000000001`–`9000000005`) can log in with OTP
  `123456`, bypassing real SMS entirely. Fine for the current pre-launch
  testing phase; **turn this off** (`ALLOW_DEMO_OTP=false`) once a real
  SMS provider is wired up and this is customer-facing.
- `ALLOW_ALL_PINCODES=false` and `ENABLE_SWAGGER=false` — correctly
  locked down for production.
- No host firewall (`ufw`) is enabled — network-level access control is
  entirely via the AWS Security Group on this instance. Only ports
  22/80/443 should be open there; worth double-checking in the AWS
  Console.
- `fail2ban` is not installed (SSH brute-force mitigation). Reasonable to
  add later; not done in this pass to avoid touching SSH/firewall config
  without your explicit sign-off.
- Password authentication over SSH is already disabled (Ubuntu AMI
  default) — key-only access, which is the important part.

## Verifying the stack is healthy

```bash
ssh -i "/Users/sayan/Downloads/Freshcuts.pem" bakalooops@ec2-13-127-81-17.ap-south-1.compute.amazonaws.com \
  "cd /opt/bakaloo/app && docker compose --env-file deploy/production/infra.env -f docker-compose.prod.yml ps"

curl https://api.fc.opslin.com/health/ready
```

All five containers (`postgres`, `redis`, `api`, `worker`, `nginx`) should
show `healthy`.

## A bug found and fixed during this deployment

While bringing the worker up, `handleAutoAssignBacklog` (and three other
call sites) were failing on every run with
`operator does not exist: text = order_status`. Migration
`106_orders_and_fulfilment.sql` converted `orders.status` from the
`order_status` enum to plain `TEXT`, but four queries across
`src/workers/processors.js`, `src/modules/coverage-map/coverage-map.repository.js`,
and `src/modules/delivery/delivery.repository.js` still cast their
parameter to `::order_status[]`. This was broken in local dev too (same
codebase), just not something anyone had noticed in the worker logs.
Fixed by casting to `::text[]` instead, matching the column's real type.
