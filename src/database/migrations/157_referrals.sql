-- 157_referrals.sql
-- Dedicated referral program (NOT coupon-code based). Rewards are granted
-- exactly once per qualification event, with idempotent reversal.

CREATE TABLE IF NOT EXISTS referral_program_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE), -- singleton
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  referrer_reward_type TEXT NOT NULL DEFAULT 'WALLET_CREDIT'
    CHECK (referrer_reward_type IN ('POINTS', 'WALLET_CREDIT', 'COUPON')),
  referrer_reward_amount NUMERIC(10,2) NOT NULL DEFAULT 100.00 CHECK (referrer_reward_amount >= 0),
  referrer_reward_coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  referee_reward_type TEXT NOT NULL DEFAULT 'WALLET_CREDIT'
    CHECK (referee_reward_type IN ('POINTS', 'WALLET_CREDIT', 'COUPON')),
  referee_reward_amount NUMERIC(10,2) NOT NULL DEFAULT 50.00 CHECK (referee_reward_amount >= 0),
  referee_reward_coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  min_first_order_value NUMERIC(10,2) NOT NULL DEFAULT 199.00 CHECK (min_first_order_value >= 0),
  qualification_event TEXT NOT NULL DEFAULT 'ORDER_DELIVERED'
    CHECK (qualification_event IN ('ORDER_PLACED', 'PAYMENT_CONFIRMED', 'ORDER_DELIVERED', 'RETURN_WINDOW_CLOSED')),
  max_referrals_per_month INTEGER CHECK (max_referrals_per_month IS NULL OR max_referrals_per_month > 0),
  reward_expiry_days INTEGER CHECK (reward_expiry_days IS NULL OR reward_expiry_days > 0),
  campaign_starts_at TIMESTAMP,
  campaign_ends_at TIMESTAMP,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO referral_program_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL UNIQUE,
  share_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  referral_code_id UUID REFERENCES referral_codes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('CLICKED', 'REGISTERED', 'ORDER_PLACED', 'QUALIFIED', 'REWARDED', 'REJECTED', 'REVERSED')),
  clicked_at TIMESTAMP,
  registered_at TIMESTAMP,
  qualifying_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  qualified_at TIMESTAMP,
  reward_generated_at TIMESTAMP,
  rejected_reason TEXT,
  reversed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- One reward generation / reversal per referral, forever (idempotency).
CREATE TABLE IF NOT EXISTS referral_reward_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('REFERRER_REWARD', 'REFEREE_REWARD', 'REVERSAL')),
  beneficiary_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('POINTS', 'WALLET_CREDIT', 'COUPON')),
  reward_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_reward_events_referral ON referral_reward_events(referral_id);

COMMENT ON TABLE referrals IS 'Referral attribution ledger. A referred user can be attributed to exactly one referrer (UNIQUE referred_user_id).';
