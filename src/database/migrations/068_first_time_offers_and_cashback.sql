-- 068_first_time_offers_and_cashback.sql
--
-- Phase 2 of the customer-segment marketing system:
--
-- 1. first_time_offers: admin-defined graduated rewards for a customer's
--    first order (e.g. ₹299 → free delivery, ₹499 → ₹20 cashback,
--    ₹999 → ₹100 cashback). Multiple rows can be active; at checkout the
--    best-fit rule (highest min_order_amount the cart still satisfies)
--    wins. cashback_credit_trigger controls WHEN a WALLET_CASHBACK reward
--    actually lands in the wallet — after payment success, after the
--    order is confirmed, or after delivery (default, safest against
--    cancellations).
--
-- 2. cashback_transactions: a single generic ledger for every cashback
--    source (coupon / first-time-offer / cart-milestone-later), so
--    crediting/cancelling logic lives in one place regardless of which
--    feature produced the reward. credit_trigger is a denormalized copy
--    of the source's configured trigger at creation time, so the credit
--    hooks don't need to join back to coupons/first_time_offers to know
--    when to act.
--
-- 3. wallet_transactions gains sub_type/source_id/order_id — the backend
--    has never populated these even though the dashboard's WalletTransaction
--    type already expects a `subType` (REFUND|BONUS|SCRATCH|CASHBACK|
--    ORDER|TOPUP). This finally wires that up.
--
-- Fully additive: safe defaults, new tables/columns only, no impact on
-- existing orders/payments/wallet/coupon flows.

CREATE TABLE IF NOT EXISTS first_time_offers (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                     VARCHAR(100) NOT NULL,
  min_order_amount         DECIMAL(10,2) NOT NULL DEFAULT 0,
  reward_type              VARCHAR(20) NOT NULL,
  reward_value             DECIMAL(10,2),
  max_discount             DECIMAL(10,2),
  unlock_coupon_id         UUID REFERENCES coupons(id),
  start_at                 TIMESTAMPTZ,
  end_at                   TIMESTAMPTZ,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  auto_apply               BOOLEAN NOT NULL DEFAULT true,
  payment_method_scope     VARCHAR(20) NOT NULL DEFAULT 'ALL',
  cashback_credit_trigger  VARCHAR(20) NOT NULL DEFAULT 'ORDER_DELIVERED',
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_first_time_offers_reward_type CHECK (
    reward_type IN ('FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'WALLET_CASHBACK', 'COUPON_UNLOCK')
  ),
  CONSTRAINT chk_first_time_offers_payment_scope CHECK (
    payment_method_scope IN ('ALL', 'ONLINE_ONLY')
  ),
  CONSTRAINT chk_first_time_offers_credit_trigger CHECK (
    cashback_credit_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED')
  )
);

CREATE INDEX IF NOT EXISTS idx_first_time_offers_active
  ON first_time_offers(is_active, min_order_amount);

CREATE TABLE IF NOT EXISTS cashback_transactions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type           VARCHAR(20) NOT NULL,
  source_id             UUID,
  order_id              UUID NOT NULL REFERENCES orders(id),
  user_id               UUID NOT NULL REFERENCES users(id),
  amount                DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  credit_trigger        VARCHAR(20) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  wallet_transaction_id UUID REFERENCES wallet_transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at           TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  CONSTRAINT chk_cashback_tx_source_type CHECK (
    source_type IN ('COUPON', 'FIRST_TIME_OFFER', 'CART_MILESTONE')
  ),
  CONSTRAINT chk_cashback_tx_credit_trigger CHECK (
    credit_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED')
  ),
  CONSTRAINT chk_cashback_tx_status CHECK (
    status IN ('PENDING', 'CREDITED', 'CANCELLED')
  )
);

CREATE INDEX IF NOT EXISTS idx_cashback_tx_order ON cashback_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_cashback_tx_user ON cashback_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_cashback_tx_status ON cashback_transactions(status);

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS sub_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_wallet_tx_sub_type'
  ) THEN
    ALTER TABLE wallet_transactions
      ADD CONSTRAINT chk_wallet_tx_sub_type
      CHECK (sub_type IS NULL OR sub_type IN ('REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_order ON wallet_transactions(order_id);
