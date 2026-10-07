-- 172_auctions.sql
-- Auction mode: paid-registration, ascending (proxy-bid) auctions on marketplace products.
-- Additive & idempotent. Design: /AUCTION_DESIGN.md
--
-- Money model: the registration fee is escrowed in auction_registrations until the
-- auction reaches a terminal state; every movement is an append-only auction_fee_ledger row.

-- ── Global rules (singleton) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auction_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_registration_fee NUMERIC(10,2) NOT NULL DEFAULT 10 CHECK (min_registration_fee >= 0),
  max_registration_fee NUMERIC(10,2) NOT NULL DEFAULT 5000 CHECK (max_registration_fee >= 0),
  fee_max_pct_of_start_price NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (fee_max_pct_of_start_price BETWEEN 0 AND 100),
  increment_tiers JSONB NOT NULL DEFAULT '[
    {"from":0,"inc":10},{"from":1000,"inc":50},{"from":5000,"inc":100},
    {"from":10000,"inc":250},{"from":25000,"inc":500},{"from":50000,"inc":1000},
    {"from":100000,"inc":2500}]'::jsonb,
  anti_snipe_window_sec INTEGER NOT NULL DEFAULT 120 CHECK (anti_snipe_window_sec >= 0),
  anti_snipe_extend_sec INTEGER NOT NULL DEFAULT 120 CHECK (anti_snipe_extend_sec >= 0),
  max_extensions INTEGER NOT NULL DEFAULT 10 CHECK (max_extensions >= 0),
  min_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (min_duration_minutes > 0),
  max_duration_days INTEGER NOT NULL DEFAULT 14 CHECK (max_duration_days > 0),
  payment_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (payment_window_hours > 0),
  max_offer_rounds INTEGER NOT NULL DEFAULT 2 CHECK (max_offer_rounds >= 1),
  vendor_fee_share_pct NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (vendor_fee_share_pct BETWEEN 0 AND 100),
  loser_fee_refund_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (loser_fee_refund_pct BETWEEN 0 AND 100),
  vendor_auctions_require_approval BOOLEAN NOT NULL DEFAULT TRUE,
  max_live_auctions_per_vendor INTEGER NOT NULL DEFAULT 10 CHECK (max_live_auctions_per_vendor > 0),
  strike_limit INTEGER NOT NULL DEFAULT 3 CHECK (strike_limit > 0),
  bid_rate_limit_per_minute INTEGER NOT NULL DEFAULT 30 CHECK (bid_rate_limit_per_minute > 0),
  blocked_states TEXT[] NOT NULL DEFAULT '{}',
  consent_text_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  consent_text TEXT NOT NULL DEFAULT 'I understand the registration fee is charged to my wallet now. If I win, it is deducted from the price I pay. If I do not win, the fee is not refunded unless stated on this auction.',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO auction_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Auctions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_number VARCHAR(30) NOT NULL UNIQUE,
  product_id UUID NOT NULL REFERENCES products(id),
  shop_product_id UUID REFERENCES shop_products(id),
  shop_id UUID REFERENCES shops(id),
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,   -- NULL = platform-owned
  owner_type TEXT NOT NULL CHECK (owner_type IN ('ADMIN', 'VENDOR')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (created_by_role IN ('ADMIN', 'VENDOR')),

  title VARCHAR(200) NOT NULL,
  description TEXT,
  image_url TEXT,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED', 'LIVE', 'PAUSED',
    'AWAITING_PAYMENT', 'SOLD', 'UNSOLD', 'CANCELLED', 'DEFAULTED')),

  start_price NUMERIC(12,2) NOT NULL CHECK (start_price > 0),
  reserve_price NUMERIC(12,2) CHECK (reserve_price IS NULL OR reserve_price >= start_price),
  bid_increment NUMERIC(12,2) CHECK (bid_increment IS NULL OR bid_increment > 0),   -- fixed step; NULL → tiers
  increment_tiers JSONB,                                                            -- snapshot of settings tiers at creation
  buy_now_price NUMERIC(12,2) CHECK (buy_now_price IS NULL OR buy_now_price > start_price),
  registration_fee NUMERIC(10,2) NOT NULL CHECK (registration_fee >= 0),
  -- rule snapshots (a settings change never alters a running auction)
  fee_vendor_share_pct NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (fee_vendor_share_pct BETWEEN 0 AND 100),
  loser_fee_refund_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (loser_fee_refund_pct BETWEEN 0 AND 100),
  anti_snipe_window_sec INTEGER NOT NULL DEFAULT 120,
  anti_snipe_extend_sec INTEGER NOT NULL DEFAULT 120,
  max_extensions INTEGER NOT NULL DEFAULT 10,
  extension_count INTEGER NOT NULL DEFAULT 0,
  payment_window_hours INTEGER NOT NULL DEFAULT 24,
  max_offer_rounds INTEGER NOT NULL DEFAULT 2,

  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  original_ends_at TIMESTAMPTZ NOT NULL,
  paused_at TIMESTAMPTZ,
  CHECK (ends_at > starts_at),

  -- live state (denormalised; auction_bids is the ledger)
  current_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  leader_id UUID REFERENCES users(id) ON DELETE SET NULL,
  leader_max NUMERIC(12,2),                 -- PRIVATE proxy ceiling, never serialised to clients
  bid_count INTEGER NOT NULL DEFAULT 0,
  bidder_count INTEGER NOT NULL DEFAULT 0,  -- distinct users who have bid
  registration_count INTEGER NOT NULL DEFAULT 0,
  bid_seq BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  stock_reserved BOOLEAN NOT NULL DEFAULT FALSE,

  -- settlement
  winner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  winning_bid NUMERIC(12,2),
  fee_credit NUMERIC(10,2),
  amount_due NUMERIC(12,2),
  offer_round INTEGER NOT NULL DEFAULT 0,
  declined_winners UUID[] NOT NULL DEFAULT '{}',
  payment_deadline TIMESTAMPTZ,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ended_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  cancelled_reason TEXT,
  relisted_from UUID REFERENCES auctions(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- one non-terminal auction per product
CREATE UNIQUE INDEX IF NOT EXISTS uq_auctions_active_product ON auctions (product_id)
  WHERE status IN ('PENDING_APPROVAL', 'SCHEDULED', 'LIVE', 'PAUSED', 'AWAITING_PAYMENT');
CREATE INDEX IF NOT EXISTS idx_auctions_status_ends ON auctions (status, ends_at);
CREATE INDEX IF NOT EXISTS idx_auctions_status_starts ON auctions (status, starts_at);
CREATE INDEX IF NOT EXISTS idx_auctions_vendor ON auctions (vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_auctions_leader ON auctions (leader_id) WHERE leader_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auctions_winner ON auctions (winner_id) WHERE winner_id IS NOT NULL;

-- ── Registrations (fee escrow) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auction_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bidder_no INTEGER NOT NULL,
  fee_amount NUMERIC(10,2) NOT NULL CHECK (fee_amount >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'APPLIED', 'REFUNDED', 'FORFEITED')),
  refund_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  forfeited_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (forfeited_amount >= 0),
  highest_bid NUMERIC(12,2),
  bid_count INTEGER NOT NULL DEFAULT 0,
  last_bid_at TIMESTAMPTZ,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_text_version VARCHAR(20),
  ip TEXT,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, user_id),
  UNIQUE (auction_id, bidder_no)
);
CREATE INDEX IF NOT EXISTS idx_auction_reg_user ON auction_registrations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_reg_auction_status ON auction_registrations (auction_id, status);

-- ── Bid log (append-only) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auction_bids (
  id BIGSERIAL PRIMARY KEY,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_id UUID REFERENCES auction_registrations(id) ON DELETE SET NULL,
  seq BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),        -- visible price level after this bid
  max_amount NUMERIC(12,2),                                 -- PRIVATE
  bid_type TEXT NOT NULL CHECK (bid_type IN ('MANUAL', 'AUTO', 'BUY_NOW')),
  is_leading BOOLEAN NOT NULL DEFAULT FALSE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction ON auction_bids (auction_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_auction_bids_user ON auction_bids (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_bids_ip ON auction_bids (auction_id, ip) WHERE ip IS NOT NULL;

-- ── Fee ledger (append-only, idempotent) ────────────────────────────────
CREATE TABLE IF NOT EXISTS auction_fee_ledger (
  id BIGSERIAL PRIMARY KEY,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  registration_id UUID REFERENCES auction_registrations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'FEE_CHARGED', 'FEE_REFUNDED', 'FEE_APPLIED_TO_ORDER', 'FEE_FORFEIT_PLATFORM', 'FEE_FORFEIT_VENDOR')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auction_fee_ledger_auction ON auction_fee_ledger (auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_fee_ledger_type_date ON auction_fee_ledger (entry_type, created_at);

-- ── Watchlist, audit trail, bidder profiles ─────────────────────────────
CREATE TABLE IF NOT EXISTS auction_watchers (
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ending_soon_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auction_id, user_id)
);

CREATE TABLE IF NOT EXISTS auction_events (
  id BIGSERIAL PRIMARY KEY,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auction_events_auction ON auction_events (auction_id, id DESC);

CREATE TABLE IF NOT EXISTS auction_bidder_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  strikes INTEGER NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason TEXT,
  blocked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  blocked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Links into existing tables ──────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auction_id UUID;
CREATE INDEX IF NOT EXISTS idx_orders_auction ON orders (auction_id) WHERE auction_id IS NOT NULL;

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_tx_sub_type;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_sub_type CHECK (
  sub_type IS NULL OR sub_type IN (
    'REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP', 'AUCTION_FEE', 'AUCTION_REFUND')
);

-- ── RBAC: auctions.* for platform roles; vendors are gated by vendor scope ─
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['auctions.view', 'auctions.manage', 'auctions.moderate', 'auctions.settings'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['auctions.view', 'auctions.manage'])
           ) s)))
 WHERE name IN ('Marketing Manager', 'Catalog Manager')
   AND NOT (permissions ? '*');

COMMENT ON TABLE auction_registrations IS 'Escrowed entry fees. ACTIVE = held; settled to APPLIED/REFUNDED/FORFEITED at the auction terminal event.';
COMMENT ON TABLE auction_fee_ledger IS 'Append-only. Every fee movement; idempotency_key makes settlement safe to retry.';
COMMENT ON COLUMN auctions.leader_max IS 'Private proxy-bid ceiling. Must never be returned by any customer-facing endpoint.';
