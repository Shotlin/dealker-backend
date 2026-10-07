-- 173_sponsored_ads.sql
-- Sponsored Products: vendor-funded, pay-per-click promotion of marketplace listings.
-- Additive & idempotent. Design: /ADS_DESIGN.md
--
-- Money model: vendors prepay an ad wallet (topped up from their settlement balance, or
-- credited by the platform). Every click charge / top-up / refund is an append-only
-- ad_wallet_ledger row; ad_wallets.balance is a cache that is only changed in the same
-- transaction as the ledger row.
--
-- Pricing model: generalized second price. Ad rank = bid × quality. The advertiser pays the
-- minimum CPC that keeps its position (never more than its own bid, never less than the floor).

-- ── Global rules (singleton) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  campaigns_require_approval BOOLEAN NOT NULL DEFAULT TRUE,
  min_cpc NUMERIC(8,2) NOT NULL DEFAULT 2.00 CHECK (min_cpc > 0),
  max_cpc NUMERIC(8,2) NOT NULL DEFAULT 500.00 CHECK (max_cpc >= min_cpc),
  min_daily_budget NUMERIC(10,2) NOT NULL DEFAULT 100.00 CHECK (min_daily_budget > 0),
  min_topup NUMERIC(10,2) NOT NULL DEFAULT 500.00 CHECK (min_topup > 0),
  max_topup NUMERIC(12,2) NOT NULL DEFAULT 200000.00 CHECK (max_topup >= min_topup),
  gst_pct NUMERIC(5,2) NOT NULL DEFAULT 18.00 CHECK (gst_pct BETWEEN 0 AND 50),
  slots_per_page INTEGER NOT NULL DEFAULT 4 CHECK (slots_per_page BETWEEN 0 AND 12),
  first_slot_position INTEGER NOT NULL DEFAULT 0 CHECK (first_slot_position >= 0),
  slot_spacing INTEGER NOT NULL DEFAULT 4 CHECK (slot_spacing >= 1),
  max_ads_per_vendor_per_page INTEGER NOT NULL DEFAULT 2 CHECK (max_ads_per_vendor_per_page >= 1),
  min_quality_score NUMERIC(4,3) NOT NULL DEFAULT 0.25 CHECK (min_quality_score BETWEEN 0 AND 1),
  click_dedupe_minutes INTEGER NOT NULL DEFAULT 30 CHECK (click_dedupe_minutes >= 0),
  impression_token_ttl_minutes INTEGER NOT NULL DEFAULT 60 CHECK (impression_token_ttl_minutes > 0),
  attribution_window_days INTEGER NOT NULL DEFAULT 7 CHECK (attribution_window_days BETWEEN 1 AND 30),
  max_campaigns_per_vendor INTEGER NOT NULL DEFAULT 20 CHECK (max_campaigns_per_vendor > 0),
  max_products_per_campaign INTEGER NOT NULL DEFAULT 100 CHECK (max_products_per_campaign > 0),
  max_keywords_per_campaign INTEGER NOT NULL DEFAULT 200 CHECK (max_keywords_per_campaign > 0),
  low_balance_threshold NUMERIC(10,2) NOT NULL DEFAULT 200.00 CHECK (low_balance_threshold >= 0),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ad_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Vendor ad wallet ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_wallets (
  vendor_id UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_topup NUMERIC(12,2) NOT NULL DEFAULT 0,
  lifetime_spend NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ad_wallet_ledger (
  id BIGSERIAL PRIMARY KEY,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'TOPUP_SETTLEMENT',   -- moved from settlement balance (+)
    'TOPUP_ADMIN',        -- platform credited a paid top-up (+)
    'PROMO_CREDIT',       -- platform-funded promotional credit (+)
    'CLICK_CHARGE',       -- pay-per-click charge, includes GST (−)
    'CLICK_REFUND',       -- invalid-click refund (+)
    'WITHDRAW_SETTLEMENT',-- unused balance moved back to settlement (−)
    'ADJUSTMENT'          -- manual correction (+/−)
  )),
  amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),    -- signed, gross (incl. tax_amount)
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,          -- GST part of a CLICK_CHARGE/REFUND (positive)
  balance_after NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
  campaign_id UUID,
  click_id UUID,
  reason TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(120) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_wallet_ledger_vendor ON ad_wallet_ledger (vendor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ad_wallet_ledger_campaign ON ad_wallet_ledger (campaign_id) WHERE campaign_id IS NOT NULL;

-- ── Campaigns ───────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ad_campaign_seq START 1001;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_number VARCHAR(20) NOT NULL UNIQUE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'SUSPENDED', 'ENDED')),
  targeting TEXT NOT NULL DEFAULT 'AUTO' CHECK (targeting IN ('AUTO', 'MANUAL')),
  default_bid NUMERIC(8,2) NOT NULL CHECK (default_bid > 0),    -- max CPC for AUTO, fallback for keywords
  daily_budget NUMERIC(10,2) NOT NULL CHECK (daily_budget > 0),
  total_budget NUMERIC(12,2) CHECK (total_budget IS NULL OR total_budget > 0),
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ends_on DATE,
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  rejected_reason TEXT,
  suspended_reason TEXT,
  paused_reason TEXT,                 -- e.g. 'OUT_OF_FUNDS' set by the system
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_vendor ON ad_campaigns (vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_active ON ad_campaigns (status, starts_on, ends_on) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS ad_campaign_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_product_id UUID REFERENCES shop_products(id) ON DELETE SET NULL,
  bid_override NUMERIC(8,2) CHECK (bid_override IS NULL OR bid_override > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaign_products_product ON ad_campaign_products (product_id);

CREATE TABLE IF NOT EXISTS ad_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  keyword VARCHAR(80) NOT NULL,                                  -- normalised: lowercase, single-spaced
  match_type TEXT NOT NULL DEFAULT 'BROAD' CHECK (match_type IN ('EXACT', 'PHRASE', 'BROAD')),
  is_negative BOOLEAN NOT NULL DEFAULT FALSE,                    -- negative keywords block the campaign for that query
  bid NUMERIC(8,2) CHECK (bid IS NULL OR bid > 0),               -- NULL → campaign default_bid
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, keyword, match_type, is_negative)
);
CREATE INDEX IF NOT EXISTS idx_ad_keywords_campaign ON ad_keywords (campaign_id);

-- ── Clicks (the billing events) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce VARCHAR(40) NOT NULL UNIQUE,                 -- from the signed impression token: one click per impression
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  keyword TEXT,                                      -- NULL for AUTO
  query_text TEXT,
  cpc NUMERIC(8,2) NOT NULL DEFAULT 0,               -- net price charged (0 when not charged)
  tax_amount NUMERIC(8,2) NOT NULL DEFAULT 0,
  charged BOOLEAN NOT NULL DEFAULT FALSE,
  not_charged_reason TEXT,                           -- DUPLICATE, SELF_CLICK, BUDGET_EXHAUSTED, NO_FUNDS, INACTIVE
  refunded BOOLEAN NOT NULL DEFAULT FALSE,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_campaign ON ad_clicks (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_vendor ON ad_clicks (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_user_product ON ad_clicks (user_id, product_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ad_clicks_keyword ON ad_clicks (keyword, created_at DESC) WHERE keyword IS NOT NULL;

-- ── Daily rollup (impressions, clicks, spend) ───────────────────────────
CREATE TABLE IF NOT EXISTS ad_stats_daily (
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  spend NUMERIC(12,2) NOT NULL DEFAULT 0,            -- net of GST
  PRIMARY KEY (campaign_id, product_id, day)
);
CREATE INDEX IF NOT EXISTS idx_ad_stats_day ON ad_stats_daily (day);

-- ── Audit trail for campaign state changes ──────────────────────────────
CREATE TABLE IF NOT EXISTS ad_events (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (actor_kind IN ('ADMIN', 'VENDOR', 'SYSTEM')),
  event TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_events_campaign ON ad_events (campaign_id, id DESC);

-- ── RBAC: ads.* for platform roles; vendors are gated by vendor scope ───
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['ads.view', 'ads.manage', 'ads.moderate', 'ads.settings', 'ads.billing'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['ads.view', 'ads.manage'])
           ) s)))
 WHERE name IN ('Marketing Manager')
   AND NOT (permissions ? '*');

COMMENT ON TABLE ad_wallet_ledger IS 'Append-only. ad_wallets.balance is a cache updated in the same transaction; idempotency_key makes top-ups/refunds safe to retry.';
COMMENT ON TABLE ad_clicks IS 'One row per impression token redeemed. charged=false rows are kept (duplicates, self-clicks, exhausted budgets) for fraud review and attribution.';
