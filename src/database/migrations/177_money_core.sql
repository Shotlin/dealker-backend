-- 177_money_core.sql
-- Admin "money core": commission rules (vendor / category / product, B2B / B2C),
-- fee + tax breakdown on seller orders, reason-coded vendor wallet ledger and
-- paid / remaining split on orders. Additive and idempotent.

-- ── 1. Commission rules ───────────────────────────────────────────────────
-- Resolution order for one item: PRODUCT > CATEGORY > VENDOR > GLOBAL, and
-- inside a scope a channel-specific rule (B2C / B2B) beats an ALL rule.
-- tax_pct is GST charged on the platform's own fees (commission + platform
-- charge); it is not the product GST.
CREATE TABLE IF NOT EXISTS commission_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'VENDOR', 'CATEGORY', 'PRODUCT')),
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'ALL' CHECK (channel IN ('ALL', 'B2C', 'B2B')),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  platform_charge_flat NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (platform_charge_flat >= 0),
  platform_charge_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (platform_charge_pct >= 0 AND platform_charge_pct <= 100),
  tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0 AND tax_pct <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT commission_rules_scope_target CHECK (
    (scope = 'GLOBAL'   AND vendor_id IS NULL     AND category_id IS NULL     AND product_id IS NULL) OR
    (scope = 'VENDOR'   AND vendor_id IS NOT NULL AND category_id IS NULL     AND product_id IS NULL) OR
    (scope = 'CATEGORY' AND category_id IS NOT NULL AND vendor_id IS NULL     AND product_id IS NULL) OR
    (scope = 'PRODUCT'  AND product_id IS NOT NULL  AND vendor_id IS NULL     AND category_id IS NULL)
  )
);

-- One active rule per (scope target, channel).
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_rules_target
  ON commission_rules (
    scope,
    COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    channel
  ) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_commission_rules_vendor ON commission_rules(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commission_rules_category ON commission_rules(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commission_rules_product ON commission_rules(product_id) WHERE product_id IS NOT NULL;

-- ── 2. Fee + tax breakdown snapshot on seller orders ──────────────────────
ALTER TABLE seller_orders
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'B2C' CHECK (channel IN ('B2C', 'B2B')),
  ADD COLUMN IF NOT EXISTS platform_charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (platform_charge >= 0),
  ADD COLUMN IF NOT EXISTS fee_tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee_tax_amount >= 0),
  ADD COLUMN IF NOT EXISTS fee_breakdown JSONB;

-- ── 3. Vendor wallet = reason-coded view of the settlement ledger ─────────
-- The ledger stays append-only and authoritative; we add a machine-readable
-- reason code, the balance before the entry, and a typed reference.
ALTER TABLE settlement_ledger
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS balance_before NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS reference_type TEXT,
  ADD COLUMN IF NOT EXISTS reference_id TEXT;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'settlement_ledger'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%entry_type%'
  LOOP
    EXECUTE format('ALTER TABLE settlement_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE settlement_ledger
  ADD CONSTRAINT settlement_ledger_entry_type_check CHECK (entry_type IN (
    'GROSS_SALES', 'SELLER_DISCOUNT', 'PLATFORM_DISCOUNT', 'COMMISSION',
    'LOGISTICS', 'REFUND', 'PENALTY', 'ADJUSTMENT', 'INCENTIVE', 'PAYOUT',
    'PLATFORM_CHARGE', 'TAX', 'CANCELLATION_CHARGE', 'BONUS',
    'CAMPAIGN_EARNING', 'AUCTION_SALE', 'SETTLEMENT',
    'MANUAL_CREDIT', 'MANUAL_DEBIT'
  ));

-- Backfill balance_before / reason_code for existing rows.
UPDATE settlement_ledger
   SET balance_before = ROUND(balance_after - amount, 2)
 WHERE balance_before IS NULL;

UPDATE settlement_ledger
   SET reason_code = CASE entry_type
     WHEN 'GROSS_SALES' THEN 'ORDER_PAYMENT_RECEIVED'
     WHEN 'SELLER_DISCOUNT' THEN 'ORDER_PAYMENT_RECEIVED'
     WHEN 'PLATFORM_DISCOUNT' THEN 'ORDER_PAYMENT_RECEIVED'
     WHEN 'COMMISSION' THEN 'PLATFORM_COMMISSION'
     WHEN 'LOGISTICS' THEN 'SHIPPING_CHARGE'
     WHEN 'REFUND' THEN 'REFUND_ADJUSTMENT'
     WHEN 'PENALTY' THEN 'PENALTY'
     WHEN 'INCENTIVE' THEN 'BONUS'
     WHEN 'PAYOUT' THEN 'SETTLEMENT'
     WHEN 'ADJUSTMENT' THEN CASE WHEN amount > 0 THEN 'MANUAL_CREDIT' ELSE 'MANUAL_DEBIT' END
     ELSE entry_type
   END
 WHERE reason_code IS NULL;

-- Every writer (order posting, refunds, adjustments, payouts) gets
-- balance_before + a reason_code without each insert having to know about them.
CREATE OR REPLACE FUNCTION settlement_ledger_fill_defaults() RETURNS trigger AS $fn$
BEGIN
  IF NEW.balance_before IS NULL THEN
    NEW.balance_before := ROUND(NEW.balance_after - NEW.amount, 2);
  END IF;
  IF NEW.reason_code IS NULL THEN
    NEW.reason_code := CASE NEW.entry_type
      WHEN 'GROSS_SALES' THEN 'ORDER_PAYMENT_RECEIVED'
      WHEN 'SELLER_DISCOUNT' THEN 'ORDER_PAYMENT_RECEIVED'
      WHEN 'PLATFORM_DISCOUNT' THEN 'ORDER_PAYMENT_RECEIVED'
      WHEN 'COMMISSION' THEN 'PLATFORM_COMMISSION'
      WHEN 'LOGISTICS' THEN 'SHIPPING_CHARGE'
      WHEN 'REFUND' THEN 'REFUND_ADJUSTMENT'
      WHEN 'PENALTY' THEN 'PENALTY'
      WHEN 'INCENTIVE' THEN 'BONUS'
      WHEN 'PAYOUT' THEN 'SETTLEMENT'
      WHEN 'ADJUSTMENT' THEN CASE WHEN NEW.amount > 0 THEN 'MANUAL_CREDIT' ELSE 'MANUAL_DEBIT' END
      ELSE NEW.entry_type
    END;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_ledger_defaults ON settlement_ledger;
CREATE TRIGGER trg_settlement_ledger_defaults
  BEFORE INSERT ON settlement_ledger
  FOR EACH ROW EXECUTE FUNCTION settlement_ledger_fill_defaults();

CREATE INDEX IF NOT EXISTS idx_settlement_ledger_reason ON settlement_ledger(reason_code);

-- ── 4. Paid / remaining split on orders (COD + partial payment) ───────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_plan TEXT NOT NULL DEFAULT 'FULL_ONLINE'
    CHECK (payment_plan IN ('FULL_ONLINE', 'COD', 'PARTIAL')),
  ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_due >= 0);

-- Backfill: COD orders owe the bill until delivered; everything else that is
-- PAID has been paid in full.
UPDATE orders
   SET payment_plan = CASE WHEN payment_method = 'COD' THEN 'COD' ELSE 'FULL_ONLINE' END,
       amount_paid = CASE
         WHEN payment_status = 'PAID' THEN total_payable + COALESCE(wallet_amount, 0)
         ELSE COALESCE(wallet_amount, 0) END,
       amount_due = CASE
         WHEN payment_status = 'PAID' THEN 0
         ELSE total_payable END
 WHERE amount_paid = 0 AND amount_due = 0;

-- ── 5. Permissions ────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['commission.view','commission.manage','vendor_wallet.view','vendor_wallet.manage'])))
   )
 WHERE name IN ('Platform Admin', 'Finance Manager');

COMMENT ON TABLE commission_rules IS 'Commission / platform charge / fee-tax rules. Resolve PRODUCT > CATEGORY > VENDOR > GLOBAL, channel-specific before ALL.';
