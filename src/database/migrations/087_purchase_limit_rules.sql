-- 087_purchase_limit_rules.sql
-- Admin-configured purchase-restriction rules: cap how much of a category
-- or a specific product a customer may buy, per order and/or over a
-- rolling time window (e.g. "max 5 units of Dairy every 7 days"). Built to
-- stop customers from repeatedly buying the same low-margin category
-- (e.g. milk) every day while ignoring the rest of the catalog — coupons
-- are a separate system and untouched by this table.
--
-- Product-level rules override category-level rules for the same product
-- when both are active (resolved in application code, see
-- purchase-limits.repository.js#resolveEffectiveRules) — e.g. cap all of
-- Dairy at 5/week, but cap just "Amul Milk 1L" at 2/week.
--
-- Scope mirrors 055_fee_settings.sql's GLOBAL/STORE pattern for schema
-- consistency with the rest of this multi-vendor codebase, but v1 only
-- ever writes scope='GLOBAL' rows — categories and products are
-- platform-wide catalog entities (no shop_id on categories/products), and
-- the abuse this prevents is a customer's behavior, not a per-shop one: a
-- shop-scoped cap would be trivially bypassed by ordering from a
-- different shop tomorrow. STORE-level overrides are schema-ready for a
-- future iteration without a second migration.

CREATE TABLE IF NOT EXISTS purchase_limit_rules (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Scope (mirrors fee_settings)
  scope                 VARCHAR(10) NOT NULL DEFAULT 'GLOBAL',
  shop_id               UUID NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Target: exactly one of category_id / product_id, per target_type
  target_type           VARCHAR(10) NOT NULL,
  category_id           UUID NULL REFERENCES categories(id) ON DELETE CASCADE,
  product_id            UUID NULL REFERENCES products(id) ON DELETE CASCADE,

  -- Admin-facing name, shown in the dashboard list and reused verbatim in
  -- customer-facing "Maximum X units of <label> allowed..." messages.
  label                 VARCHAR(150) NOT NULL,

  -- Per-order cap (nullable — a rule may enforce only a window cap)
  max_qty_per_order     INTEGER NULL
                        CONSTRAINT chk_plr_max_per_order CHECK (max_qty_per_order IS NULL OR max_qty_per_order >= 1),

  -- Rolling window cap (nullable — a rule may enforce only a per-order cap).
  -- All four window_* fields are all-or-nothing, enforced below.
  window_enabled        BOOLEAN NOT NULL DEFAULT false,
  window_period         VARCHAR(10) NULL,          -- 'DAY' | 'WEEK' | 'MONTH'
  window_count          INTEGER NULL
                        CONSTRAINT chk_plr_window_count CHECK (window_count IS NULL OR window_count >= 1),
  max_qty_per_window    INTEGER NULL
                        CONSTRAINT chk_plr_max_per_window CHECK (max_qty_per_window IS NULL OR max_qty_per_window >= 1),

  is_active             BOOLEAN NOT NULL DEFAULT true,

  -- When true, the per-order cap (max_qty_per_order) is skipped for an
  -- order that also contains products outside this rule's scope — e.g. a
  -- "max 3 Dairy per order" rule with this on lets a customer buy 10 units
  -- of milk as long as their cart also has something that isn't Dairy. The
  -- point is to catch the "orders 5 milk and nothing else, every day"
  -- abuse pattern without penalizing a normal mixed grocery basket. Does
  -- NOT affect the rolling-window cap (max_qty_per_window), which always
  -- applies regardless of what else is in the order — otherwise a
  -- customer could permanently bypass the daily/weekly cap by tossing in
  -- one cheap unrestricted item.
  exempt_order_cap_with_other_items BOOLEAN NOT NULL DEFAULT false,

  -- Audit
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by            UUID NULL REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT chk_plr_scope CHECK (scope IN ('GLOBAL','STORE')),
  CONSTRAINT chk_plr_scope_shop CHECK (
    (scope = 'GLOBAL' AND shop_id IS NULL) OR
    (scope = 'STORE'  AND shop_id IS NOT NULL)
  ),
  CONSTRAINT chk_plr_target_type CHECK (target_type IN ('CATEGORY','PRODUCT')),
  CONSTRAINT chk_plr_target_shape CHECK (
    (target_type = 'CATEGORY' AND category_id IS NOT NULL AND product_id IS NULL) OR
    (target_type = 'PRODUCT'  AND product_id  IS NOT NULL AND category_id IS NULL)
  ),
  CONSTRAINT chk_plr_window_shape CHECK (
    (window_enabled = false AND window_period IS NULL AND window_count IS NULL AND max_qty_per_window IS NULL) OR
    (window_enabled = true  AND window_period IN ('DAY','WEEK','MONTH') AND window_count IS NOT NULL AND max_qty_per_window IS NOT NULL)
  ),
  -- A rule must restrict at least one of the two dimensions — an empty
  -- rule (no per-order cap, no window cap) is rejected at the DB level,
  -- not just by the dashboard form.
  CONSTRAINT chk_plr_has_a_cap CHECK (
    max_qty_per_order IS NOT NULL OR window_enabled = true
  )
);

-- One active-able rule per target per scope. Editing toggles is_active on
-- the same row (this is a CRUD config table, not an event log) — mirrors
-- the uq_fee_settings_global / uq_fee_settings_store precedent exactly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plr_global_category
  ON purchase_limit_rules (category_id) WHERE scope = 'GLOBAL' AND target_type = 'CATEGORY';
CREATE UNIQUE INDEX IF NOT EXISTS uq_plr_global_product
  ON purchase_limit_rules (product_id) WHERE scope = 'GLOBAL' AND target_type = 'PRODUCT';
CREATE UNIQUE INDEX IF NOT EXISTS uq_plr_store_category
  ON purchase_limit_rules (shop_id, category_id) WHERE scope = 'STORE' AND target_type = 'CATEGORY';
CREATE UNIQUE INDEX IF NOT EXISTS uq_plr_store_product
  ON purchase_limit_rules (shop_id, product_id) WHERE scope = 'STORE' AND target_type = 'PRODUCT';

-- Lookup indexes for rule resolution (only active rules matter at
-- enforcement time — cart add/update/validate and checkout all filter on
-- is_active live, so a toggle takes effect on the very next request).
CREATE INDEX IF NOT EXISTS idx_plr_category_active
  ON purchase_limit_rules (category_id) WHERE target_type = 'CATEGORY' AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_plr_product_active
  ON purchase_limit_rules (product_id) WHERE target_type = 'PRODUCT' AND is_active = true;

-- Dashboard list view (all rules, newest first)
CREATE INDEX IF NOT EXISTS idx_plr_created_at ON purchase_limit_rules (created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- The rolling-window usage query (purchase-limits.repository.js
-- #getWindowUsage) filters orders by (user_id, status, created_at) — add
-- a composite index so it never scans a user's full order history.
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_orders_user_status_created
  ON orders (user_id, status, created_at DESC);
