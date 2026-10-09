-- 186_b2b_abandoned_followups.sql
-- B2B abandoned carts = vendor-to-vendor orders awaiting payment for too long.
-- Follow-ups are an append-only log; the latest entry is the current status,
-- and an order that gets paid afterwards counts as recovered automatically.

CREATE TABLE IF NOT EXISTS b2b_checkout_followups (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES b2b_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('CONTACTED', 'WILL_PAY', 'LOST')),
  note TEXT NOT NULL CHECK (length(btrim(note)) >= 3),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_followups_order ON b2b_checkout_followups(order_id, created_at DESC);

UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['abandoned_carts.view','abandoned_carts.manage'])))
   )
 WHERE name IN ('Platform Admin', 'Support Agent', 'Marketing Manager');
