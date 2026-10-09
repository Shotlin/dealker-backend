# Sell / Exchange request evidence (photos + QC video) and request-level QC

Migration: `188_sell_request_evidence_qc.sql` (additive, idempotent). Applies cleanly on the full 1→188 chain.

## Why uploads were failing (reproduced, not assumed)

| # | Cause | Evidence | Fix |
|---|---|---|---|
| 1 | Dashboard axios client has a global `timeout: 15000` | `src/lib/api.ts`; any video / slow-network photo is cancelled at 15 s | Evidence uploads use `timeout: 0` + progress |
| 2 | nginx `client_max_body_size 10M` on every route (dev and prod configs) | Larger photos / any video → HTML 413 the app cannot parse | Dedicated location for `…/media` (520M, unbuffered, 15 min timeouts) in both configs |
| 3 | Old endpoint hard-capped photos at 5 MB, rejected HEIC (iPhone default) | 6 MB JPEG → 413 against the running API | Limits are admin-configurable (default 12 MB photo / 100 MB video); HEIC gets an explicit, actionable message |
| 4 | Old video endpoint is Cloudinary-only | `POST /uploads/video` → `UPLOAD_FAILED` with no cloud credentials | New private storage needs no third party |
| 5 | Old endpoint trusted the declared mimetype | HTML labelled `image/png` accepted and served publicly | Type decided from the file's real bytes |
| 6 | Public URL baked from `UPLOADS_PUBLIC_URL` (defaults to `localhost`) | Production without that variable stores unusable URLs | Evidence URLs are API-relative and signed; no host stored |

## Behaviour

* Two steps: **upload** (one file per request → progress / retry per file; recorded as *unattached*, owned by the uploader) then **attach** ids to a request (on create via `mediaIds`, or later). Failed uploads never half-create a request.
* Stored under `PRIVATE_UPLOAD_DIR/sell-evidence` (compose volume `private_uploads_data`) — never under public `/uploads`. Storage is isolated behind `evidence-storage.js` (`saveEvidence / evidencePath / removeEvidence`) so S3/GCS is a one-file swap. **Back this volume up.**
* Reads use HMAC-signed links minted only after the normal visibility check; valid 30–45 min, stable per 15-min bucket (cache friendly), bound to one file id, support `Range` (video seeking). Headers: `nosniff`, `CSP: sandbox`, `CORP: cross-origin`.
* Attached evidence is immutable (DB trigger blocks delete/rewrite of bytes, checksum, stage); only verification fields change. Unattached uploads are swept after 24 h by `workers/evidence-cleanup.worker.js`.
* Limits (Sell settings → "Photos, video & QC"): `maxImages`, `maxVideos`, `maxImageMb`, `maxVideoMb`, per evidence stage.
* Stages: `CUSTOMER_SUBMISSION`, `PICKUP_INSPECTION`, `TECHNICIAN_QC`, `FINAL_QC`, `DISPUTE`. Customers may add `CUSTOMER_SUBMISSION`/`DISPUTE` to their own request; an *assigned* vendor may add `PICKUP_INSPECTION`; staff with `*.qc` or `*.manage` may add any.
* Historical requests (legacy `images` JSON, no media rows, no QC row) load unchanged: `media: []`, `qc.status: "NOT_STARTED"`, `imageCount` includes legacy images.

## Request QC (separate from listing QC)

`AWAITING_EVIDENCE → EVIDENCE_UPLOADED → INSPECTION_PENDING → INSPECTION_COMPLETE → PASSED | RECHECK | FAILED`
(`RECHECK → INSPECTION_PENDING`; `PASSED`/`FAILED → RECHECK` via reopen with a reason; not after the customer accepted). Invalid jumps → `409 INVALID_QC_STATE`. Every transition locks the request row and appends to `sell_request_qc_events` (append-only, trigger-enforced) with actor, role, note, time.

* IMEI rule: an observed IMEI differing from the request forces `imeiVerified=false`, and such a device cannot be `PASSED` (`IMEI_MISMATCH`).
* `PASSED` fixes the **final valuation** (defaults to the system quote) and sets `customerDecision=PENDING`; customer ACCEPT / DECLINE (DECLINE cancels the request).
* Optional gate `qcRequiredForApproval` (**off by default** → existing approval flow unchanged): approve needs `PASSED`; complete needs customer `ACCEPTED`.
* New permissions `sell_requests.qc`, `exchange_requests.qc` (granted to Platform Admin in the migration; Super Admin has all). `*.manage` also works.

## API contract (for the customer and vendor apps)

All under `/api/v1`, bearer auth. `{P}` = `sell-requests` or `exchange-requests` (customer) / `manage/sell-requests` or `manage/exchange-requests` (staff + vendor).

| Method & path | Who | Notes |
|---|---|---|
| `POST /{P}/media` | customer / staff / vendor | `multipart/form-data`, field `files` (any name works). Send **one file per request** for per-file progress. `201` all ok, `207` partial, `4xx` none ok. Body: `{success, data:{files:[{ok, filename, media}|{ok:false, filename, code, message, status}]}}` |
| `DELETE /{P}/media/:mediaId` | uploader | Only while unattached |
| `POST /{P}/:id/media` `{mediaIds, stage?}` | owner / assigned vendor / staff | Default stage `CUSTOMER_SUBMISSION` (customer) / `TECHNICIAN_QC` (staff) |
| `POST /sell-requests` (create) | customer | Now accepts `mediaIds: string[]` (legacy `images: string[]` still accepted) |
| `GET /{P}/media/:mediaId/link` | anyone who can see the request | Fresh signed link (use when a link has expired) |
| `GET /api/v1/media/sell-evidence/:id?exp&sig` | link holder | The file. No auth header — usable in `<img>`/`<video>` |
| `POST /manage/{…}/media/:mediaId/verify` `{status: VERIFIED\|REJECTED\|PENDING, note}` | `*.qc` | Reject needs a note |
| `GET /manage/{…}/:id/qc` | staff (`*.view`) | Full QC + history. Vendors get status only |
| `POST /manage/{…}/:id/qc/start` `{inspectorId?}` | `*.qc` | Needs ≥1 file (`NO_EVIDENCE`) |
| `POST /manage/{…}/:id/qc/inspection` | `*.qc` | `{physicalCondition, screenCondition, imeiVerified, imeiObserved?, batteryHealth?, functionality:{name:boolean}, remarks?}` |
| `POST /manage/{…}/:id/qc/decision` | `*.qc` | `{result: PASSED\|RECHECK\|FAILED, note, finalValuation?}` (note required unless PASSED) |
| `POST /manage/{…}/:id/qc/reopen` `{reason}` | `*.qc` | |
| `POST /{P}/:id/qc/decision` `{decision: ACCEPT\|DECLINE}` | customer (owner) | Only when QC is `PASSED` and decision is `PENDING` |

Request detail (`GET /{P}/:id`, `GET /manage/{P}/:id`) now includes `media[]` (`id, mediaType, stage, filename, mimeType, size, checksum, verification, url`), `videoCount`, and `qc`. Customers get a reduced `qc` (outcome, valuation, decision — no inspector identity or history). Resolve `url` against the API origin.

Error codes: `UNSUPPORTED_MEDIA`, `TOO_LARGE` (413), `EMPTY`, `UPLOAD_INTERRUPTED`, `STORAGE_FAILED` (503, retryable), `TOO_MANY_PENDING` (429), `TOO_MANY_PHOTOS`, `TOO_MANY_VIDEOS`, `ALREADY_ATTACHED`, `NO_EVIDENCE`, `INVALID_QC_STATE`, `IMEI_MISMATCH`, `QC_NOT_PASSED`, `CUSTOMER_NOT_ACCEPTED`.

**App integration (not in these repos):** the customer and vendor mobile apps are not part of this workspace and were not modified. They must (1) upload per file to `POST /sell-requests/media`, (2) pass `mediaIds` on create, (3) render `media[].url`, (4) show the final valuation and call `qc/decision`. HEIC must be converted to JPEG on the device.

## Deployment checklist

1. Apply migration 188 (`npm run db:migrate`) — additive only.
2. Ensure `PRIVATE_UPLOAD_DIR` is on a persistent volume (compose already mounts `private_uploads_data`) and is backed up.
3. Deploy the updated nginx config(s) (`nginx/nginx.conf`, `deploy/production/nginx/nginx.conf`) and reload. Both pass `nginx -t`.
4. If a CDN/WAF sits in front (e.g. Cloudflare), check its request-body limit is ≥ the video limit you set (free plans cap at 100 MB).
5. Decide whether to switch `qcRequiredForApproval` on.

## Tests

`tests/integration/sell-evidence.integration.test.js` — 26 tests against real Postgres, real files, real multipart (header has the run command).
Covers: auth, JPEG/PNG/WebP, MP4/MOV, mixed batch, content sniffing (HTML-as-PNG, EXE, HEIC, empty), partial success (207), admin size limits (413 → raised → OK), storage failure → retry, interrupted upload cleanup, attach + re-read after refresh, signed link bytes/checksum/Range/416/tampered/expired/other-file/missing-on-disk, cross-customer and cross-vendor isolation, per-stage counts, orphan sweep, DB immutability, historical requests, full QC state machine incl. invalid jumps, IMEI rule, customer decision, gate on/off, evidence retained after completion, append-only history, settings validation.
