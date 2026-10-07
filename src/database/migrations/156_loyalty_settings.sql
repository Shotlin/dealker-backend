-- 156_loyalty_settings.sql
-- Admin-configurable loyalty/coins program. Points and Wallet remain two
-- separate systems. The redemption cap is enforced backend-side on every
-- quote/checkout: max_points_value = eligible_subtotal * max_redemption_pct.

CREATE TABLE IF NOT EXISTS loyalty_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE), -- singleton
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  points_per_rupee NUMERIC(8,4) NOT NULL DEFAULT 0.02
    CHECK (points_per_rupee >= 0),           -- e.g. 0.02 = 2 points per ₹100? (points earned per ₹1 spent)
  point_value NUMERIC(8,4) NOT NULL DEFAULT 1.00 CHECK (point_value > 0), -- ₹ value of one point
  min_redeemable_points INTEGER NOT NULL DEFAULT 50 CHECK (min_redeemable_points >= 0),
  max_redemption_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00
    CHECK (max_redemption_pct >= 0 AND max_redemption_pct <= 100),
  max_points_per_order INTEGER CHECK (max_points_per_order IS NULL OR max_points_per_order > 0),
  expiry_days INTEGER CHECK (expiry_days IS NULL OR expiry_days > 0),
  earning_trigger TEXT NOT NULL DEFAULT 'ORDER_DELIVERED'
    CHECK (earning_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED')),
  return_window_hold_days INTEGER NOT NULL DEFAULT 7 CHECK (return_window_hold_days >= 0),
  excluded_category_ids UUID[] NOT NULL DEFAULT '{}',
  excluded_product_ids UUID[] NOT NULL DEFAULT '{}',
  excluded_vendor_ids UUID[] NOT NULL DEFAULT '{}',
  min_order_amount_to_earn NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_order_amount_to_earn >= 0),
  stackable_with_coupons BOOLEAN NOT NULL DEFAULT TRUE,
  stackable_with_milestones BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO loyalty_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Widen the ledger vocabulary (105 created EARN|REDEEM|EXPIRE|ADJUSTMENT).
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'loyalty_transactions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%transaction_type%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE loyalty_transactions DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE loyalty_transactions
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- Re-create the vocabulary check with the full marketplace set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'loyalty_transactions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%EARN_PENDING%'
  ) THEN
    ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_type_check
      CHECK (transaction_type IN (
        'EARN_PENDING', 'EARN', 'REDEEM', 'REVERSAL', 'EXPIRE',
        'ADMIN_ADJUSTMENT', 'REFERRAL_BONUS', 'MILESTONE_BONUS', 'ADJUSTMENT'
      ));
  END IF;
END $$;

COMMENT ON TABLE loyalty_settings IS 'Platform-wide loyalty program configuration. Points liability must always be reconstructable from loyalty_transactions.';
