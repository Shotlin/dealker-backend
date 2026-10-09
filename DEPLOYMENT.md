# Dealker Backend — Demo Server Deployment

Source of truth for the **demo/testing** EC2 server. Keep it updated: after any change to the server, edit this file (also kept at `/opt/dealker/DEPLOYMENT.md` on the server).
**Backend only — the dashboard is NOT deployed here.**

## Server
- Host: `ec2-13-127-248-57.ap-south-1.compute.amazonaws.com` (13.127.248.57), AWS ap-south-1, Ubuntu 26.04, 2 vCPU / 3.7 GB RAM (+2 GB swap), 28 GB disk. **Moved here on 2026-10-09; the old server 13.201.85.54 is retired.**
- Key: `dealkerbackend.pem` lives in the workspace root (next to `dealker-backend/`, outside this git repo — never commit it); keep it `chmod 400`. Commands below assume you run them from `dealker-backend/`.
- SSH: `ssh -i "../dealkerbackend.pem" ubuntu@ec2-13-127-248-57.ap-south-1.compute.amazonaws.com` (user `ubuntu`, passwordless sudo, in `docker` group)
- Public URL: **https://api.dealker.agnixstudio.in** (Let's Encrypt via certbot, auto-renews through `certbot.timer`, issued 2026-10-09; Cloudflare A record `api.dealker` → 13.127.248.57, DNS-only). `http://13.127.248.57` still works without TLS.
- Firewall (ufw): 22, 80, 443 only. fail2ban + unattended-upgrades enabled.

## Layout
| Path | What |
|---|---|
| `/opt/dealker/app` | git clone of https://github.com/Shotlin/dealker-backend (branch `main`). Deploy-only — never edit by hand. |
| `/opt/dealker/deploy.sh` | The deploy script (see below) |
| `/opt/dealker/compose.uploads.yml` | Compose override mounting `/srv/dealker/uploads` into api/worker at `/app/uploads` (always passed with `-f`) |
| `/opt/dealker/last-deploy.log` | Output of the most recent deploy |
| `/opt/dealker/app/deploy/production/{app.env,infra.env}` | Secrets (chmod 600, git-excluded via `.git/info/exclude`). Freshly generated; not stored anywhere else. |
| `/srv/dealker/{postgres,redis,backups,uploads}` | Bind-mounted data, `pg_dump` backups, uploaded files (owned by uid 100 = container `appuser`). Host nginx serves `/uploads/` straight from this dir. |

## Architecture
```
Internet :80 → host nginx (/etc/nginx/sites-available/dealker-api.conf)
            → Docker nginx 127.0.0.1:8080 (rate limit, headers)
            → api (Fastify :3000) → postgres 16, redis 7
              worker (BullMQ jobs) → postgres, redis
```
Compose project `dealker` (`docker-compose.prod.yml`). Containers use `restart: unless-stopped` and Docker is enabled at boot, so the stack comes back after a reboot. Docker logs are capped (10 MB x 3 per container, `/etc/docker/daemon.json`). `cloudflared` and `postgres-backup` are in the `ops` profile and NOT running.

## Deploy / update (run after pushing to GitHub `main`)
```bash
ssh -i "../dealkerbackend.pem" ubuntu@ec2-13-127-248-57.ap-south-1.compute.amazonaws.com '/opt/dealker/deploy.sh'
```
Does: fetch origin/main → reset tree → pg_dump backup (keeps 5) → build → migrate → `up -d api worker nginx` → restart nginx (it caches api IPs) → wait for `/health/ready` locally and over public HTTPS → image prune. It always rebuilds.

Useful:
```bash
cd /opt/dealker/app && C="docker compose --env-file deploy/production/infra.env -f docker-compose.prod.yml -f /opt/dealker/compose.uploads.yml"
$C ps ; $C logs -f --tail 100 api worker ; df -h / ; docker system df
```
Rollback: `docker tag dealker-api:rollback-pre-<sha> dealker-api:latest` (same for worker) then `$C up -d api worker && $C restart nginx`; DB dumps in `/srv/dealker/backups`.

## Config choices (demo server)
- `ALLOW_DEMO_OTP=true`, `SMS_PROVIDER=none`: demo phones 9000000001–9000000005 log in with OTP `123456`. `ALLOW_DEMO_DELIVERY_ACTIONS=true`. **Turn off before any real use.**
- `UPLOAD_DIR=/app/uploads`, `UPLOADS_PUBLIC_URL=https://api.dealker.agnixstudio.in/uploads`; demo images (`/uploads/demo/*.svg`) were copied from the local Docker volume.
- Host nginx has `proxy_buffer_size 32k` (needed: admin login sets a huge cookie; without it login returns 502 "upstream sent too big header").
- `ENABLE_SWAGGER=false`. Razorpay, FCM, Cloudinary, 2Factor are unset (add to `app.env`, then `FORCE=1 /opt/dealker/deploy.sh`).
- Dashboard (hosted elsewhere, not on this server): https://dash.dealker.agnixstudio.in. `FRONTEND_URL`/`ADMIN_URL` point to it. `CORS_ORIGINS` = dash/apex/www/api `.dealker.agnixstudio.in` + localhost dev ports (3000-3002, 4501, 5173). Not wildcard on purpose: CORS uses `credentials: true`. To add an origin: edit `CORS_ORIGINS` in `app.env`, then `docker compose ... up -d --force-recreate api worker && ... restart nginx`. Code also always allows *.bakaloo.in, *.shotlin.in, *.vercel.app.
- No automated DB backups beyond the pre-deploy dump.

## Deploy in two commands
```bash
ssh -i "../dealkerbackend.pem" ubuntu@ec2-13-127-248-57.ap-south-1.compute.amazonaws.com   # 1) log in
/opt/dealker/deploy.sh                                                                               # 2) deploy (run on the server)
```
Or as one line from your Mac: `ssh -i "../dealkerbackend.pem" ubuntu@ec2-13-127-248-57.ap-south-1.compute.amazonaws.com '/opt/dealker/deploy.sh'`.
Ends with `=== DEPLOY OK ===` (exit 0) or `=== DEPLOY FAILED ===` (exit 1).

## Abandoned carts
- Sweep worker runs inside the **api** container (needs the socket server for live dashboard updates). A cart idle longer than `ABANDONED_CART_THRESHOLD_MINUTES` is recorded as an episode. **Demo server uses 2** (default in code: 30) — set in `app.env`.
- Reminder cooldown per cart: `ABANDONED_CART_REMINDER_COOLDOWN_MINUTES` (default 60).
- Episodes close as RECOVERED (customer touches cart), CONVERTED (order placed/paid), EXPIRED (7 days idle or cart emptied by hand).
- Admin API: `/api/v1/admin/abandoned-carts` (`/summary`, `/presets`, `/:id`, `/:id/notify`, `/bulk-notify`, `/:id/quick-coupon`, `/:id/coupon`). Dashboard page: Customers → Abandoned Carts.
- Demo data: `docker compose ... exec -T api node scripts/seed-abandoned-carts-demo.mjs` (idempotent; marker = coupons `DEMOCB*`). Seeded 2026-10-07.

## Known repo issues
- `CLOUD.md`, `routine-deploy.sh`, `redeploy-from-local.sh` in the repo describe a different (FreshCuts) server — don't use them for this one.

## Change log
- 2026-10-09: **Migrated to a new server (13.127.248.57).** Fresh install of Docker/nginx/certbot/ufw/fail2ban, repo cloned at `98623d6`, new secrets generated (`app.env`/`infra.env`), local demo DB restored (131 products, 278 orders, 75 users; `localhost:4500/uploads` URLs rewritten to `https://api.dealker.agnixstudio.in/uploads`), migration 177 applied, TLS issued, `/opt/dealker/deploy.sh` recreated (pre-deploy `pg_dump`, build, migrate, health check). Verified: `/health/ready`, public products 200, admin logins 200, demo OTP, uploaded image 200. DNS `api.dealker` already pointed at the new IP. Old server entries below are history.
- 2026-10-07: GitHub main moved to ddc0647 (includes abandoned carts + worker fix + migration 172_auctions). deploy.sh hardened (waits for every container healthy, public HTTPS check, non-zero exit on failure, stale patches only warn). Both patches removed.
- 2026-10-07: Deployed abandoned-cart feature (backend patch), seeded demo episodes (7 open), set threshold to 2 min. Verified over HTTPS: summary/list APIs 200; a real demo-customer cart was auto-detected ~2 min after last activity. deploy.sh now also runs `git clean -fdq`.
- 2026-10-07: Restored local demo DB (pg_dump of local dealker-postgres-1: 131 products, 260 orders, 14 vendors, 5 admins, 49 customers) over the empty server DB. Pre-restore backup: /srv/dealker/backups/pre-demo-restore.dump. Admin logins verified (200). Demo admin emails: superadmin@/demo@/riya@/karan@/neha@dealker.local (passwords in local docker-compose.yml / seed scripts). Re-sync demo data = repeat dump/restore.
- 2026-10-07: Added dashboard domain dash.dealker.agnixstudio.in to CORS_ORIGINS/FRONTEND_URL/ADMIN_URL; api+worker recreated. Verified preflight OK for it, blocked for unknown origins.
- 2026-10-07: Added domain api.dealker.agnixstudio.in with HTTPS (certbot --nginx, HTTP→HTTPS redirect).
- 2026-10-07: Fresh server. Installed Docker/nginx/ufw/fail2ban, cloned repo (976fc5f), generated secrets, applied 174 migrations, deployed postgres/redis/api/worker/nginx, added host nginx on :80, deploy script, patch for missing worker module. Verified health + public `/api/v1/products` = 200.
