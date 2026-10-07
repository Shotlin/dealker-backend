-- Packing proof the vendor provides for each seller order (photos / video of the item being packed).
CREATE TABLE IF NOT EXISTS seller_order_media (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_order_id UUID NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO')),
  url             TEXT NOT NULL,
  caption         TEXT,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seller_order_media_so ON seller_order_media (seller_order_id, created_at);
