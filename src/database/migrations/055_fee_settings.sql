-- 055_fee_settings.sql
-- Canonical, single-source-of-truth fee configuration for the dynamic fee +
-- distance-based delivery engine. Replaces the scattered fee sources
-- (fee_config row-per-type, hardcoded JS constants, app_settings fee keys).
--
-- Design:
--   * One GLOBAL row holds the platform-wide defaults.
--   * Optional STORE rows (scope='STORE', shop_id set) override the global
--     config per shop for multi-vendor. The TotalsEngine prefers a STORE row
--     when present and falls back to GLOBAL.
--   * Every fee block carries an enabled flag, value(s), label and description
--     so the customer-facing bill can render friendly labels with no hardcoding.
--   * Idempotent: CREATE TABLE IF NOT EXISTS + guarded seed.

CREATE TABLE IF NOT EXISTS fee_settings (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Scope
  scope                       VARCHAR(10) NOT NULL DEFAULT 'GLOBAL',
  shop_id                     UUID NULL REFERENCES shops(id) ON DELETE CASCADE,
  is_active                   BOOLEAN NOT NULL DEFAULT true,

  -- ── Delivery fee (distance-based) ──────────────────────────────
  delivery_fee_enabled        BOOLEAN NOT NULL DEFAULT true,
  min_delivery_fee            DECIMAL(10,2) NOT NULL DEFAULT 20.00
                              CONSTRAINT chk_fs_min_delivery_fee CHECK (min_delivery_fee >= 0),
  base_distance_km            DECIMAL(6,2) NOT NULL DEFAULT 1.50
                              CONSTRAINT chk_fs_base_distance CHECK (base_distance_km >= 0),
  per_km_fee                  DECIMAL(10,2) NOT NULL DEFAULT 8.00
                              CONSTRAINT chk_fs_per_km_fee CHECK (per_km_fee >= 0),
  max_delivery_distance_km    DECIMAL(6,2) NULL
                              CONSTRAINT chk_fs_max_distance CHECK (max_delivery_distance_km IS NULL OR max_delivery_distance_km >= 0),
  free_delivery_enabled       BOOLEAN NOT NULL DEFAULT true,
  free_delivery_above         DECIMAL(10,2) NULL DEFAULT 299.00
                              CONSTRAINT chk_fs_free_delivery_above CHECK (free_delivery_above IS NULL OR free_delivery_above >= 0),

  -- ── Handling fee ───────────────────────────────────────────────
  handling_fee_enabled        BOOLEAN NOT NULL DEFAULT true,
  handling_fee_type           VARCHAR(12) NOT NULL DEFAULT 'FLAT'
                              CONSTRAINT chk_fs_handling_type CHECK (handling_fee_type IN ('FLAT','PERCENT')),
  handling_fee_value          DECIMAL(10,2) NOT NULL DEFAULT 5.00
                              CONSTRAINT chk_fs_handling_value CHECK (handling_fee_value >= 0),
  handling_fee_label          VARCHAR(60) NOT NULL DEFAULT 'Handling fee',
  handling_fee_description    TEXT DEFAULT 'Covers packing and order handling.',

  -- ── Platform fee ───────────────────────────────────────────────
  platform_fee_enabled        BOOLEAN NOT NULL DEFAULT true,
  platform_fee_type           VARCHAR(12) NOT NULL DEFAULT 'FLAT'
                              CONSTRAINT chk_fs_platform_type CHECK (platform_fee_type IN ('FLAT','PERCENT')),
  platform_fee_value          DECIMAL(10,2) NOT NULL DEFAULT 5.00
                              CONSTRAINT chk_fs_platform_value CHECK (platform_fee_value >= 0),
  platform_fee_label          VARCHAR(60) NOT NULL DEFAULT 'Platform fee',
  platform_fee_description    TEXT DEFAULT 'Supports platform operations and support.',

  -- ── Small cart fee ─────────────────────────────────────────────
  small_cart_fee_enabled      BOOLEAN NOT NULL DEFAULT false,
  small_cart_threshold        DECIMAL(10,2) NOT NULL DEFAULT 99.00
                              CONSTRAINT chk_fs_small_cart_threshold CHECK (small_cart_threshold >= 0),
  small_cart_fee              DECIMAL(10,2) NOT NULL DEFAULT 0.00
                              CONSTRAINT chk_fs_small_cart_fee CHECK (small_cart_fee >= 0),
  small_cart_fee_label        VARCHAR(60) NOT NULL DEFAULT 'Small cart fee',
  small_cart_fee_description  TEXT DEFAULT 'Applied to small orders below the minimum cart value.',

  -- ── Surge / rain fee ───────────────────────────────────────────
  surge_fee_enabled           BOOLEAN NOT NULL DEFAULT false,
  surge_fee_value             DECIMAL(10,2) NOT NULL DEFAULT 0.00
                              CONSTRAINT chk_fs_surge_value CHECK (surge_fee_value >= 0),
  surge_fee_label             VARCHAR(60) NOT NULL DEFAULT 'Surge fee',
  surge_fee_description       TEXT DEFAULT 'Temporary surcharge during high demand or bad weather.',

  -- ── Packaging fee ──────────────────────────────────────────────
  packaging_fee_enabled       BOOLEAN NOT NULL DEFAULT false,
  packaging_fee_value         DECIMAL(10,2) NOT NULL DEFAULT 0.00
                              CONSTRAINT chk_fs_packaging_value CHECK (packaging_fee_value >= 0),
  packaging_fee_label         VARCHAR(60) NOT NULL DEFAULT 'Packaging fee',
  packaging_fee_description   TEXT DEFAULT 'Covers eco-friendly packaging materials.',

  -- ── Delivery ETA (display only) ────────────────────────────────
  delivery_eta_minutes        INTEGER NOT NULL DEFAULT 30
                              CONSTRAINT chk_fs_eta CHECK (delivery_eta_minutes >= 0),

  -- ── Audit ──────────────────────────────────────────────────────
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                  UUID NULL REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT chk_fee_settings_scope CHECK (scope IN ('GLOBAL','STORE')),
  -- A STORE row must carry a shop_id; a GLOBAL row must not.
  CONSTRAINT chk_fee_settings_scope_shop CHECK (
    (scope = 'GLOBAL' AND shop_id IS NULL) OR
    (scope = 'STORE'  AND shop_id IS NOT NULL)
  ),
  -- max distance, when set, must be greater than the included base distance.
  CONSTRAINT chk_fs_max_gt_base CHECK (
    max_delivery_distance_km IS NULL OR max_delivery_distance_km >= base_distance_km
  )
);

-- Exactly one GLOBAL row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_settings_global
  ON fee_settings ((1))
  WHERE scope = 'GLOBAL';

-- At most one STORE row per shop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_settings_store
  ON fee_settings (shop_id)
  WHERE scope = 'STORE';

-- Seed the single GLOBAL row with the launch defaults
-- (min ₹20, base 1.5km, ₹8/km, free delivery above ₹299, max delivery 10km).
INSERT INTO fee_settings (scope, shop_id, max_delivery_distance_km)
SELECT 'GLOBAL', NULL, 10.00
WHERE NOT EXISTS (SELECT 1 FROM fee_settings WHERE scope = 'GLOBAL');
