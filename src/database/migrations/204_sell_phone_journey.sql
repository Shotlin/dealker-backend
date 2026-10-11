-- 204_sell_phone_journey.sql
-- "Sell your phone" journey: IMEI verification, estimate range, offer window, customer accepts a vendor offer,
-- pickup / drop-off with courier tracking, vendor funding (escrow), inspection price, customer payout.
-- Customers sell to verified vendors only. Additive and idempotent.

-- ── Settings ────────────────────────────────────────────────────────────
ALTER TABLE sell_settings
  ADD COLUMN IF NOT EXISTS offer_window_minutes INTEGER NOT NULL DEFAULT 60 CHECK (offer_window_minutes BETWEEN 5 AND 1440),
  ADD COLUMN IF NOT EXISTS max_offer_refreshes INTEGER NOT NULL DEFAULT 3 CHECK (max_offer_refreshes BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS estimate_spread_pct NUMERIC(5,2) NOT NULL DEFAULT 8 CHECK (estimate_spread_pct BETWEEN 0 AND 50),
  ADD COLUMN IF NOT EXISTS require_vendor_funding BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS pickup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS dropoff_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payout_wallet_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payout_upi_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payout_bank_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── IMEI: our own blocklist + an audit of every check ───────────────────
CREATE TABLE IF NOT EXISTS sell_imei_blocklist (
  imei VARCHAR(15) PRIMARY KEY CHECK (imei ~ '^[0-9]{15}$'),
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'POLICE', 'CEIR', 'CUSTOMER_DISPUTE', 'PROVIDER')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sell_imei_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  imei VARCHAR(15) NOT NULL,
  model_id UUID REFERENCES sell_device_models(id) ON DELETE SET NULL,
  eligible BOOLEAN NOT NULL,
  checks JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_imei_checks_user ON sell_imei_checks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sell_imei_checks_imei ON sell_imei_checks (imei, created_at DESC);

-- ── Request: journey ────────────────────────────────────────────────────
ALTER TABLE sell_requests
  ADD COLUMN IF NOT EXISTS imei_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimate_min NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS estimate_max NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS offers_close_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offer_refreshes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accepted_offer_id UUID,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'LISTED' CHECK (stage IN (
    'LISTED', 'OFFER_ACCEPTED', 'PICKUP_REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED',
    'INSPECTING', 'FINAL_PRICE', 'PAYOUT_PENDING', 'PAID', 'RETURNING', 'CLOSED')),
  ADD COLUMN IF NOT EXISTS fulfilment TEXT CHECK (fulfilment IN ('PICKUP', 'DROP_OFF')),
  ADD COLUMN IF NOT EXISTS pickup_address TEXT,
  ADD COLUMN IF NOT EXISTS pickup_pincode VARCHAR(10),
  ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC(10,8),
  ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC(11,8),
  ADD COLUMN IF NOT EXISTS pickup_date DATE,
  ADD COLUMN IF NOT EXISTS pickup_window VARCHAR(40),
  ADD COLUMN IF NOT EXISTS pickup_note VARCHAR(300),
  ADD COLUMN IF NOT EXISTS vendor_payment_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (vendor_payment_status IN ('NONE', 'PENDING', 'SUBMITTED', 'HELD', 'REFUNDING', 'REFUNDED')),
  ADD COLUMN IF NOT EXISTS vendor_held_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_method TEXT CHECK (payout_method IN ('WALLET', 'UPI', 'BANK')),
  ADD COLUMN IF NOT EXISTS payout_details TEXT,                       -- encrypted JSON (UPI id / bank account); never returned in full
  ADD COLUMN IF NOT EXISTS payout_display VARCHAR(80),                -- masked label shown to the customer
  ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (payout_status IN ('NONE', 'PENDING', 'PROCESSING', 'PAID', 'FAILED')),
  ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS payout_reference VARCHAR(80),
  ADD COLUMN IF NOT EXISTS payout_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_sell_requests_stage ON sell_requests (stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sell_requests_payout ON sell_requests (payout_status) WHERE payout_status IN ('PENDING', 'PROCESSING');
CREATE INDEX IF NOT EXISTS idx_sell_requests_open_offers ON sell_requests (offers_close_at) WHERE status IN ('PENDING', 'IN_PROGRESS');

-- ── Pickup (courier) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_pickups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL UNIQUE REFERENCES sell_requests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF')),
  awb VARCHAR(60),
  courier_name VARCHAR(120),
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'PICKUP_SCHEDULED'
    CHECK (status IN ('PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED')),
  provider_status VARCHAR(80),
  scheduled_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_pickups_awb ON sell_pickups (awb) WHERE awb IS NOT NULL;

CREATE TABLE IF NOT EXISTS sell_pickup_events (
  id BIGSERIAL PRIMARY KEY,
  pickup_id UUID NOT NULL REFERENCES sell_pickups(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL,
  provider_status VARCHAR(80),
  note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_pickup_events ON sell_pickup_events (pickup_id, occurred_at);

-- ── Money: vendor funding (escrow), customer payout, vendor refund. Append-only. ──
CREATE TABLE IF NOT EXISTS sell_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('VENDOR_FUNDING', 'CUSTOMER_PAYOUT', 'VENDOR_REFUND')),
  method TEXT NOT NULL CHECK (method IN ('UPI', 'BANK', 'CARD', 'CASH', 'WALLET', 'RAZORPAY')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'PROCESSING', 'PAID', 'FAILED')),
  reference VARCHAR(80),
  note VARCHAR(300),
  idempotency_key VARCHAR(80) NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sell_payments_req ON sell_payments (request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sell_payments_open ON sell_payments (kind, status) WHERE status IN ('SUBMITTED', 'PROCESSING');

-- ── RBAC: finance (confirm vendor funding, mark payouts paid) ───────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT 'sell_requests.finance'
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

-- ── Wallet: a sale payout is its own transaction sub-type ───────────────
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_tx_sub_type;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_sub_type CHECK (
  sub_type IS NULL OR sub_type IN (
    'REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP', 'AUCTION_FEE', 'AUCTION_REFUND', 'SELL_PAYOUT')
);
