-- One-time coupons a vendor sends to a shopper who left THAT vendor's product in the cart.
-- The coupon itself is an ordinary row in `coupons` (SHOP_COUPON, INDIVIDUAL target, usage 1, scoped to the product);
-- this table only records who sent it for which cart so the vendor can see it and its status.
CREATE TABLE IF NOT EXISTS abandoned_cart_vendor_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  abandoned_cart_id UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  product_name TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FLAT')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  notification_id UUID,
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acvc_cart_vendor ON abandoned_cart_vendor_coupons (abandoned_cart_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_acvc_coupon ON abandoned_cart_vendor_coupons (coupon_id);
