-- 044_coupons_multi_store.sql
-- Multi-vendor: extend the existing `coupons` table with the columns and
-- CHECK constraints needed for multi-store-aware discounts, and create the
-- append-only `coupon_usages` table that ledger-records each per-shop
-- application of a coupon at checkout. Together these schema changes are
-- the storage substrate for Requirement 26 (Coupons and Vouchers,
-- Multi-Store Aware).
--
-- Why this migration exists (R26 background):
--   * The legacy single-vendor `coupons` table (migration 007) modelled a
--     single global discount space. The multi-vendor world introduces
--     PLATFORM_COUPON / SHOP_COUPON / CATEGORY_COUPON / PRODUCT_COUPON /
--     DELIVERY_COUPON, the absorber concept (PLATFORM vs SHOP — i.e.
--     who eats the discount on the ledger; see R24 AC#5 and design §10),
--     and the optional shop / category / product scoping arrays.
--   * The legacy `coupon_usages` table (also migration 007) tracked one
--     row per (coupon, user, order); it does not carry shop_id or
--     absorber, both of which are required by R26 AC#4 and the
--     COUPON_DISCOUNT shop-transactions wiring in design §10.3. A new,
--     parallel `coupon_usages` table is therefore created via
--     `CREATE TABLE IF NOT EXISTS`. On a fresh database this migration
--     defines the canonical multi-store schema for the table; on a
--     legacy database the IF NOT EXISTS guard is a no-op and the legacy
--     schema remains in place — the legacy → multi-store reshape is
--     intentionally out of scope for migration 044 (Phase A is schema
--     only; data backfill and reshape land later in coupon application
--     wiring).
--
-- Column extensions to `coupons` (idempotent — every ALTER uses
-- IF NOT EXISTS; per design §3.2.6 + R26 AC#1):
--   * coupon_type             VARCHAR(20)
--                               DEFAULT 'PLATFORM_COUPON'
--                                       — the coupon kind. CHECK-
--                                         constrained to PLATFORM_COUPON,
--                                         SHOP_COUPON, CATEGORY_COUPON,
--                                         PRODUCT_COUPON, DELIVERY_COUPON
--                                         via `chk_coupons_type` below.
--                                         Default keeps every legacy
--                                         single-vendor row classified
--                                         as a PLATFORM_COUPON without
--                                         an explicit backfill.
--   * absorber                VARCHAR(10)
--                               DEFAULT 'PLATFORM'
--                                       — financial cost bearer (R24
--                                         AC#5). CHECK-constrained to
--                                         PLATFORM, SHOP via
--                                         `chk_coupons_absorber` below.
--                                         Default classifies legacy rows
--                                         as PLATFORM-absorbed, matching
--                                         their PLATFORM_COUPON default.
--   * shop_id                 UUID
--                               REFERENCES shops(id)
--                                       — the owning shop for
--                                         SHOP_COUPON. NULL for every
--                                         other type. Required-when-
--                                         SHOP_COUPON enforced by
--                                         `chk_coupons_shop_required`
--                                         below.
--   * applicable_shop_ids     UUID[]    — optional shop allow-list for
--                                         PLATFORM_COUPON. NULL means
--                                         the coupon applies globally
--                                         (R26 AC#7(a)); a non-NULL
--                                         array restricts the coupon to
--                                         the listed shops.
--   * applicable_category_ids UUID[]    — optional category scope used
--                                         by CATEGORY_COUPON
--                                         (R26 AC#7(c)). NULL when not
--                                         category-scoped.
--   * applicable_product_ids  UUID[]    — optional product scope used
--                                         by PRODUCT_COUPON
--                                         (R26 AC#7(c)). NULL when not
--                                         product-scoped.
--   * min_order_amount        DECIMAL(10,2)
--                               DEFAULT 0.00
--                                       — minimum cart value gating
--                                         redemption (R26 AC#8 →
--                                         COUPON_MIN_ORDER_NOT_MET).
--   * usage_limit_total       INTEGER   — global redemption ceiling.
--                                         NULL means unlimited
--                                         (R26 AC#8 →
--                                         COUPON_LIMIT_REACHED).
--   * usage_limit_per_user    INTEGER
--                               DEFAULT 1
--                                       — per-customer redemption
--                                         ceiling (R26 AC#8 →
--                                         COUPON_USER_LIMIT_REACHED).
--   * is_active               BOOLEAN
--                               DEFAULT true
--                                       — soft on/off toggle for the
--                                         coupon; participates in the
--                                         `idx_coupons_type_active`
--                                         lookup index below.
--   * created_by              UUID
--                               REFERENCES users(id)
--                                       — the HQ_User or SHOP_ADMIN who
--                                         created the coupon (powers
--                                         R26 AC#13 audit-trail context
--                                         and the R26 AC#5/AC#6 scope
--                                         enforcement).
--
-- CHECK constraints on `coupons` (per design §3.2.6 + R26 AC#2, AC#3):
--   * chk_coupons_type
--       — coupon_type IN
--         ('PLATFORM_COUPON','SHOP_COUPON','CATEGORY_COUPON',
--          'PRODUCT_COUPON','DELIVERY_COUPON').
--   * chk_coupons_absorber
--       — absorber IN ('PLATFORM','SHOP').
--   * chk_coupons_shop_required (R26 AC#2)
--       — coupon_type <> 'SHOP_COUPON'
--           OR (shop_id IS NOT NULL AND absorber = 'SHOP').
--         Guarantees a SHOP_COUPON cannot exist without a concrete
--         owning shop and an absorber that points at that shop.
--   * chk_coupons_platform_absorber (R26 AC#3)
--       — coupon_type <> 'PLATFORM_COUPON' OR absorber = 'PLATFORM'.
--         Guarantees a PLATFORM_COUPON's cost is always absorbed by the
--         Platform.
--
--   Each constraint is created inside a `DO $$ ... END $$` block guarded
--   by a `pg_constraint` lookup so re-running the migration is a no-op
--   (no `duplicate_object` raised on the second pass).
--
-- Indexes on `coupons` (per design §3.2.6):
--   * idx_coupons_shop         — partial `(shop_id) WHERE shop_id IS NOT
--                                NULL`. Powers the shop-scoped coupon
--                                listing endpoint and the SHOP_COUPON
--                                lookup at checkout without bloating the
--                                base `coupons` table for global
--                                PLATFORM_COUPON rows.
--   * idx_coupons_type_active  — `(coupon_type, is_active)`. Powers the
--                                "active coupons of type X" filter used
--                                by both the dashboard listing endpoints
--                                (R26 AC#6) and the checkout-time
--                                applicability scan (R26 AC#7).
--
-- New table: `coupon_usages` (per design §3.2.6 + R26 AC#4):
--   * id              UUID PK         — surrogate identifier.
--   * coupon_id       UUID NOT NULL   — FK → coupons(id); the coupon
--                                       that was redeemed.
--   * order_id        UUID NOT NULL   — FK → orders(id); the per-shop
--                                       order this row is attached to
--                                       (R26 AC#9 inserts one row per
--                                       per-shop order group affected).
--   * customer_id     UUID NOT NULL   — FK → users(id); the redeeming
--                                       Customer; powers the
--                                       per-customer usage-limit check
--                                       (R26 AC#8 →
--                                       COUPON_USER_LIMIT_REACHED) via
--                                       `idx_coupon_usages_customer`.
--   * shop_id         UUID NOT NULL   — FK → shops(id); the per-shop
--                                       order group affected; required
--                                       by R26 AC#4 + AC#10 because the
--                                       same coupon application can
--                                       fan out into multiple shops in
--                                       a multi-shop cart and each
--                                       shop's COUPON_DISCOUNT
--                                       shop_transaction must reference
--                                       its own coupon_usages row.
--   * discount_amount DECIMAL(10,2)
--                       NOT NULL
--                       CHECK (>= 0)  — distributed (and possibly
--                                       capped per R26 AC#11) discount
--                                       attributed to this per-shop
--                                       group; non-negative because
--                                       discounts never increase the
--                                       cart total.
--   * absorber        VARCHAR(10)
--                       NOT NULL
--                       CHECK IN
--                       ('PLATFORM','SHOP')
--                                     — copy of the parent coupon's
--                                       absorber at redemption time so
--                                       the ledger is robust against
--                                       later edits to the coupon
--                                       (R26 AC#10, design §10.3).
--   * created_at      TIMESTAMPTZ
--                       NOT NULL
--                       DEFAULT NOW() — ledger write timestamp; rows
--                                       are immutable so this also
--                                       serves as effective-at and
--                                       drives the `created_at DESC`
--                                       ordering on the per-coupon and
--                                       per-shop indexes below.
--
-- Append-only contract (R26 AC#4, design §12.4 + §17 "Property 7"):
--   * The application path only INSERTs and SELECTs `coupon_usages` —
--     never UPDATE, never DELETE. The application PostgreSQL role
--     (`bakaloo_app`) is granted INSERT+SELECT only on this table; ALL
--     is reserved for the migration role (`bakaloo_admin`). This is
--     enforced at deploy time (design §10 + §12.4) and re-checked by a
--     static grep in CI (design §17 Property 7).
--   * The R26 AC#11 "cap to 0" rule does NOT mutate an existing usage
--     row — it persists the already-capped `discount_amount` on the
--     INSERT itself.
--
-- Indexes on `coupon_usages` (per design §3.2.6):
--   * idx_coupon_usages_coupon        — `(coupon_id, created_at DESC)`.
--                                       Powers per-coupon usage history
--                                       and the `usage_limit_total`
--                                       counter at checkout (R26 AC#8).
--   * idx_coupon_usages_customer      — `(customer_id, coupon_id)`.
--                                       Powers the per-customer usage
--                                       limit check (R26 AC#8 →
--                                       COUPON_USER_LIMIT_REACHED).
--   * idx_coupon_usages_order         — `(order_id)`. Powers reverse
--                                       lookups from an order to the
--                                       coupon application(s) that
--                                       contributed to its discount
--                                       lines.
--   * idx_coupon_usages_shop_created  — `(shop_id, created_at DESC)`.
--                                       Powers the per-shop coupon
--                                       redemption listing used by
--                                       shop-scoped reports (R27).
--
-- Idempotent: re-running this migration is a no-op. Every column
-- addition uses `ADD COLUMN IF NOT EXISTS`, every CHECK constraint is
-- created inside a `DO $$` block guarded by a `pg_constraint` lookup,
-- the new table uses `CREATE TABLE IF NOT EXISTS`, and every index uses
-- `CREATE INDEX IF NOT EXISTS`.
--
-- Note: this migration only ships the schema. The HQ + shop-scoped
-- coupon CRUD endpoints (R26 AC#5, AC#6, AC#12), the multi-shop
-- distribution algorithm (R26 AC#7, AC#11), the per-shop
-- COUPON_DISCOUNT shop_transactions wiring (R26 AC#10, design §10.3),
-- and the audit_logs emissions (R26 AC#13) all live in subsequent
-- tasks. The DB-role grant that operationally enforces the append-only
-- contract on `coupon_usages` is wired in the deploy script per
-- design §10 + §12.4.
--
-- Requirements: R26.1, R26.2, R26.3, R26.4
-- Design:       §3.2.6 of .kiro/specs/multi-vendor-system/design.md

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS coupon_type             VARCHAR(20)   DEFAULT 'PLATFORM_COUPON';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS absorber                VARCHAR(10)   DEFAULT 'PLATFORM';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS shop_id                 UUID          REFERENCES shops(id);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS applicable_shop_ids     UUID[];
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS applicable_category_ids UUID[];
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS applicable_product_ids  UUID[];
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS min_order_amount        DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS usage_limit_total       INTEGER;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS usage_limit_per_user    INTEGER       DEFAULT 1;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS is_active               BOOLEAN       DEFAULT true;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS created_by              UUID          REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_type'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_type
      CHECK (coupon_type IN (
        'PLATFORM_COUPON',
        'SHOP_COUPON',
        'CATEGORY_COUPON',
        'PRODUCT_COUPON',
        'DELIVERY_COUPON'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_absorber'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_absorber
      CHECK (absorber IN ('PLATFORM','SHOP'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_shop_required'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_shop_required
      CHECK (
        coupon_type <> 'SHOP_COUPON'
        OR (shop_id IS NOT NULL AND absorber = 'SHOP')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_platform_absorber'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_platform_absorber
      CHECK (
        coupon_type <> 'PLATFORM_COUPON'
        OR absorber = 'PLATFORM'
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coupons_shop
  ON coupons (shop_id)
  WHERE shop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coupons_type_active
  ON coupons (coupon_type, is_active);

CREATE TABLE IF NOT EXISTS coupon_usages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id       UUID NOT NULL REFERENCES coupons(id),
  order_id        UUID NOT NULL REFERENCES orders(id),
  customer_id     UUID NOT NULL REFERENCES users(id),
  shop_id         UUID NOT NULL REFERENCES shops(id),
  discount_amount DECIMAL(10,2) NOT NULL CHECK (discount_amount >= 0),
  absorber        VARCHAR(10) NOT NULL CHECK (absorber IN ('PLATFORM','SHOP')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns to legacy coupon_usages table if they don't exist
ALTER TABLE coupon_usages ADD COLUMN IF NOT EXISTS customer_id     UUID REFERENCES users(id);
ALTER TABLE coupon_usages ADD COLUMN IF NOT EXISTS shop_id         UUID REFERENCES shops(id);
ALTER TABLE coupon_usages ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE coupon_usages ADD COLUMN IF NOT EXISTS absorber        VARCHAR(10) DEFAULT 'PLATFORM';
ALTER TABLE coupon_usages ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon
  ON coupon_usages (coupon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_usages_customer
  ON coupon_usages (customer_id, coupon_id);

CREATE INDEX IF NOT EXISTS idx_coupon_usages_order
  ON coupon_usages (order_id);

CREATE INDEX IF NOT EXISTS idx_coupon_usages_shop_created
  ON coupon_usages (shop_id, created_at DESC);

COMMENT ON TABLE coupon_usages IS
  'Append-only coupon usage ledger. Application role MUST hold INSERT+SELECT only.';
