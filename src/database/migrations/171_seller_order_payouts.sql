-- Links a vendor payout to the parcel(s) it settles, so each order can show "paid on … (UTR …)".
CREATE TABLE IF NOT EXISTS seller_order_payouts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payout_id       UUID NOT NULL REFERENCES settlement_payouts(id) ON DELETE CASCADE,
  seller_order_id UUID NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_order_id, payout_id)
);
CREATE INDEX IF NOT EXISTS idx_so_payouts_so ON seller_order_payouts (seller_order_id);
