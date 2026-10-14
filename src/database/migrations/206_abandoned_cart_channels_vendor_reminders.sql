-- 206_abandoned_cart_channels_vendor_reminders.sql
-- Vendor-facing abandoned carts.
--
--  1. An abandonment episode now belongs to one cart CHANNEL: a customer can hold a retail
--     (B2C) and a wholesale (B2B) cart at the same time, and each is its own episode.
--     Existing rows are all retail. The "one OPEN episode" rule becomes per (user, channel).
--  2. Vendors see only their own slice of an episode (items from their shops) and may send
--     a reminder about THOSE items only. Every vendor reminder is logged here so cooldowns
--     and caps are per vendor, and so the admin can see who nudged whom.
-- Additive and idempotent.

ALTER TABLE abandoned_carts
  ADD COLUMN IF NOT EXISTS price_mode VARCHAR(10) NOT NULL DEFAULT 'retail';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_price_mode_check') THEN
    ALTER TABLE abandoned_carts
      ADD CONSTRAINT abandoned_carts_price_mode_check CHECK (price_mode IN ('retail', 'wholesale'));
  END IF;
END $$;

DROP INDEX IF EXISTS uq_abandoned_carts_open_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_abandoned_carts_open_user_mode
  ON abandoned_carts (user_id, price_mode) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_mode
  ON abandoned_carts (price_mode, status, abandoned_at DESC);

-- Vendor slice lookups join items → shops → vendor.
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_items_shop
  ON abandoned_cart_items (shop_id) WHERE shop_id IS NOT NULL;

-- Timeline gains a vendor-sent reminder; actors gain VENDOR.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'abandoned_cart_events'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) ILIKE '%event_type%' OR pg_get_constraintdef(oid) ILIKE '%actor_type%')
  LOOP
    EXECUTE format('ALTER TABLE abandoned_cart_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE abandoned_cart_events ADD CONSTRAINT abandoned_cart_events_event_type_check
  CHECK (event_type IN ('DETECTED','RESWEPT','RECOVERED','CONVERTED','EXPIRED','REMINDER_SENT','COUPON_ISSUED','VENDOR_REMINDER_SENT'));
ALTER TABLE abandoned_cart_events ADD CONSTRAINT abandoned_cart_events_actor_type_check
  CHECK (actor_type IN ('SYSTEM','ADMIN','CUSTOMER','VENDOR'));

CREATE TABLE IF NOT EXISTS abandoned_cart_vendor_reminders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  abandoned_cart_id  UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  vendor_id          UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  notification_id    UUID REFERENCES notifications(id) ON DELETE SET NULL,
  template_key       VARCHAR(30) NOT NULL,
  product_ids        UUID[] NOT NULL DEFAULT '{}',
  sent_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acvr_cart_vendor
  ON abandoned_cart_vendor_reminders (abandoned_cart_id, vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acvr_vendor
  ON abandoned_cart_vendor_reminders (vendor_id, created_at DESC);

COMMENT ON TABLE abandoned_cart_vendor_reminders IS
  'One row per reminder a vendor sent about their own items in an abandoned cart. Drives per-vendor cooldown/caps and the admin audit trail.';
