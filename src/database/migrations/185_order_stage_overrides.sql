-- 185_order_stage_overrides.sql
-- Admin manual override of an order's fulfilment stage (Order Placed →
-- Payment → Vendor Confirmation → QC → Packing → Shipping → Out for
-- Delivery → Delivered → Completed). Every override keeps who, why and what
-- changed. Needs the `orders.override` permission.

CREATE TABLE IF NOT EXISTS order_stage_overrides (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('PAYMENT', 'VENDOR_CONFIRMATION', 'QC', 'PACKING', 'SHIPPING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  from_status TEXT,
  to_status TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_stage_overrides_order ON order_stage_overrides(order_id, created_at DESC);

UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT 'orders.override'))
   )
 WHERE name = 'Platform Admin';
