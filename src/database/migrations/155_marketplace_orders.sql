-- 155_marketplace_orders.sql
-- Flipkart-style two-level order model. A parent customer order (`orders`,
-- shop_id NULL) is the complete checkout; each vendor/shop group becomes one
-- `seller_orders` row; every order item belongs to exactly one seller order.
-- The legacy single-shop model is preserved: shop_id stays nullable and old
-- rows are untouched.

CREATE TABLE IF NOT EXISTS seller_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_order_number VARCHAR(30) NOT NULL UNIQUE,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ORDER_PLACED'
    CHECK (status IN (
      'ORDER_PLACED', 'CONFIRMED', 'PACKED', 'READY_TO_SHIP', 'SHIPPED',
      'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED',
      'RETURNED', 'CLOSED'
    )),
  item_subtotal DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (item_subtotal >= 0),
  seller_discount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (seller_discount >= 0),
  platform_discount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (platform_discount >= 0),
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  commission_amount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  shipping_charge DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (shipping_charge >= 0),
  payable_to_seller DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (payable_to_seller >= 0),
  fulfilment_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (fulfilment_status IN ('PENDING', 'PROCESSING', 'PACKED', 'READY_TO_SHIP', 'DISPATCHED', 'DELIVERED', 'CANCELLED')),
  shipping_provider TEXT,
  shipment_id UUID,
  invoice_number VARCHAR(40),
  invoice_url TEXT,
  payout_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (payout_status IN ('PENDING', 'ELIGIBLE', 'PROCESSING', 'PAID', 'ON_HOLD', 'REVERSED')),
  estimated_delivery TIMESTAMP,
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancellation_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_orders_order ON seller_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_seller_orders_vendor ON seller_orders(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_orders_shop ON seller_orders(shop_id) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_orders_status ON seller_orders(status);
CREATE INDEX IF NOT EXISTS idx_seller_orders_payout ON seller_orders(payout_status);

-- Every order item belongs to a seller order (mandatory for marketplace rows).
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS seller_order_id UUID REFERENCES seller_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,2);

CREATE INDEX IF NOT EXISTS idx_order_items_seller_order ON order_items(seller_order_id) WHERE seller_order_id IS NOT NULL;

-- Parent-order extras (marketplace totals snapshot).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS coupon_discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_absorber TEXT CHECK (coupon_absorber IN ('PLATFORM', 'SHOP')),
  ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0),
  ADD COLUMN IF NOT EXISTS shipping_charge DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_marketplace BOOLEAN NOT NULL DEFAULT FALSE;

-- Parent order numbers: MK-YYYYMMDD-NNNNN, allocated inside the caller's tx.
CREATE TABLE IF NOT EXISTS marketplace_order_sequences (
  order_date DATE NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (order_date)
);

COMMENT ON TABLE seller_orders IS 'Per-vendor sub-order of a parent customer order (155). Vendor dashboards only ever see rows where vendor_id matches their JWT claim.';
COMMENT ON COLUMN orders.is_marketplace IS 'TRUE for two-level marketplace checkouts (parent order with seller_orders children).';
