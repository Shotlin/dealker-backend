-- 043_audit_logs.sql
-- Multi-vendor: introduce the append-only `audit_logs` table — the canonical
-- system-of-record for every mutating and security-relevant action emitted
-- by the Platform. The table is the source of truth for incident
-- investigation, compliance evidence, and the HQ + per-shop audit-log
-- reader endpoints introduced by Requirement 28 (R28 AC#6, AC#7).
--
-- Append-only contract (R28 AC#3, design §12.4 + §17 "Property 7"):
--   * Application paths only INSERT and SELECT — never UPDATE, never
--     DELETE. The application PostgreSQL role (`bakaloo_app`) is granted
--     INSERT+SELECT only on this table; ALL is reserved for the
--     migration role (`bakaloo_admin`). This is enforced at deploy time
--     (design §10) and re-checked by a static grep in CI (design §17
--     Property 7).
--   * The `COMMENT ON TABLE` below is the in-database reminder of that
--     contract; reviewers and DBAs see it via `\d+ audit_logs`.
--
-- Columns (per design §3.2.5 + R28 AC#1):
--   * id              UUID PK         — surrogate identifier.
--   * actor_user_id   UUID            — FK → users(id); the User who
--                                       initiated the action. Nullable
--                                       because login_failure and other
--                                       unauthenticated security events
--                                       (R28 AC#4) write rows with a
--                                       null actor.
--   * actor_role      VARCHAR(50)     — snapshot of the actor's role at
--                                       write time (HQ_Role or
--                                       Shop_Role string) so audit
--                                       trails survive subsequent role
--                                       changes; nullable for
--                                       unauthenticated events.
--   * actor_shop_id   UUID            — FK → shops(id); the
--                                       Active_Shop_Id at the moment
--                                       of the action. Nullable for
--                                       HQ-scoped actions and
--                                       unauthenticated events.
--   * target_type     VARCHAR(50)
--                       NOT NULL      — kind of resource the action
--                                       acted on. R28 AC#1 enumerates:
--                                       shop, shop_staff, shop_product,
--                                       order, coupon, transaction,
--                                       payout, user, session.
--                                       Free-form (no CHECK) so new
--                                       integrations can add target
--                                       kinds without a migration.
--   * target_id       UUID            — id of the affected resource;
--                                       nullable because some actions
--                                       (e.g. login_failure with an
--                                       unknown email) have no target
--                                       row.
--   * action          VARCHAR(80)
--                       NOT NULL      — the audit action verb. R28 AC#4
--                                       lists the minimum vocabulary
--                                       (login_success, login_failure,
--                                       session_revoked,
--                                       password_changed,
--                                       password_reset, staff_created,
--                                       staff_role_changed,
--                                       staff_deactivated,
--                                       staff_password_reset,
--                                       shop_product_created,
--                                       shop_product_updated,
--                                       stock_changed,
--                                       shop_products_bulk_price_updated,
--                                       shop_product_rejected,
--                                       order_status_changed,
--                                       rider_assigned, rider_approved,
--                                       coupon_created, coupon_updated,
--                                       coupon_deleted,
--                                       payout_marked_paid,
--                                       payout_held, payout_released,
--                                       shop_updated,
--                                       transaction_posted,
--                                       permission_denied,
--                                       cross_shop_access_blocked,
--                                       auto_assignment_failed). Kept
--                                       free-form (no CHECK) so new
--                                       audit verbs can be introduced
--                                       without a migration.
--   * before          JSONB           — row state prior to the
--                                       mutation, or null for create /
--                                       login events. Sensitive columns
--                                       (password_hash,
--                                       force_password_change_token,
--                                       bank_account_number) are
--                                       stripped before write per
--                                       R28 AC#5 — that redaction is an
--                                       application-layer invariant
--                                       enforced by the emit helper in
--                                       design §12.2.
--   * after           JSONB           — row state after the mutation,
--                                       or null for delete events;
--                                       same redaction rules as
--                                       `before`.
--   * ip_address      INET            — request source IP captured by
--                                       the Fastify hook; nullable
--                                       because background-job emitters
--                                       have no request context.
--   * user_agent      VARCHAR(500)    — request user-agent header,
--                                       same nullability rationale as
--                                       `ip_address`.
--   * created_at      TIMESTAMPTZ
--                       NOT NULL
--                       DEFAULT NOW() — write timestamp; ledger rows
--                                       are immutable so this is also
--                                       the effective-at timestamp and
--                                       drives the `created_at DESC`
--                                       ordering of the read endpoints
--                                       (R28 AC#6).
--
-- Indexes (per design §3.2.5):
--   * idx_audit_logs_actor_user     — `(actor_user_id)`. Powers the
--                                     actor filter on
--                                     GET /api/v1/admin/audit-logs and
--                                     GET /api/v1/shop-audit-logs
--                                     (R28 AC#6, AC#7).
--   * idx_audit_logs_actor_shop     — `(actor_shop_id)`. Powers the
--                                     shop-scope predicate on
--                                     GET /api/v1/shop-audit-logs and
--                                     the shop filter on the HQ reader
--                                     (R28 AC#7).
--   * idx_audit_logs_target         — composite `(target_type,
--                                     target_id)`. Powers
--                                     "show me everything that
--                                     happened to this resource"
--                                     queries from both readers
--                                     (R28 AC#6, AC#7).
--   * idx_audit_logs_action_created — `(action, created_at DESC)`.
--                                     Powers the action filter
--                                     combined with the default
--                                     `created_at DESC` ordering
--                                     (R28 AC#6).
--   * idx_audit_logs_created        — `(created_at DESC)`. Powers the
--                                     unfiltered default listing and
--                                     the date-range scan on both
--                                     readers (R28 AC#2, AC#6).
--
-- Idempotent: re-running this migration is a no-op. Table creation
-- uses `CREATE TABLE IF NOT EXISTS` and every index uses
-- `CREATE INDEX IF NOT EXISTS`. The `COMMENT ON TABLE` is
-- unconditionally safe to re-issue.
--
-- Note: this migration only ships the schema. The emit helper
-- (`src/modules/audit-logs/audit-logs.service.js`), the read endpoints
-- (HQ + shop-scoped), the Fastify hook that captures ip_address /
-- user_agent, and the redaction of password_hash /
-- force_password_change_token / bank_account_number live in
-- subsequent tasks (Phase audit-logs); the DB-role grant that
-- operationally enforces append-only is wired in the deploy script per
-- design §10 + §12.4.
--
-- Requirements: R28.1, R28.2, R28.3
-- Design:       §3.2.5 of .kiro/specs/multi-vendor-system/design.md

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id   UUID REFERENCES users(id),
  actor_role      VARCHAR(50),
  actor_shop_id   UUID REFERENCES shops(id),
  target_type     VARCHAR(50) NOT NULL,
  target_id       UUID,
  action          VARCHAR(80) NOT NULL,
  before          JSONB,
  after           JSONB,
  ip_address      INET,
  user_agent      VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user     ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_shop     ON audit_logs(actor_shop_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target         ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created        ON audit_logs(created_at DESC);

COMMENT ON TABLE audit_logs IS
  'Append-only audit log. Application role MUST hold INSERT+SELECT only.';
