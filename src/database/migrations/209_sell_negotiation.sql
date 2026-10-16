-- 209_sell_negotiation.sql
-- Sell your phone: the customer talks to each buyer (vendor) about their offer before accepting.
-- One thread per (request, vendor). Also: admin-managed artwork for the app's Sell landing page.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS sell_request_messages (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('CUSTOMER', 'VENDOR')),
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  customer_read_at TIMESTAMPTZ,
  vendor_read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_msgs_thread ON sell_request_messages (request_id, vendor_id, id);
CREATE INDEX IF NOT EXISTS idx_sell_msgs_unread_customer ON sell_request_messages (request_id) WHERE sender_role = 'VENDOR' AND customer_read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sell_msgs_unread_vendor ON sell_request_messages (vendor_id) WHERE sender_role = 'CUSTOMER' AND vendor_read_at IS NULL;

-- Artwork for the Sell landing page (image URLs; empty = the app's bundled default art).
ALTER TABLE sell_settings
  ADD COLUMN IF NOT EXISTS hub_banner_url TEXT,
  ADD COLUMN IF NOT EXISTS hub_step_icons JSONB NOT NULL DEFAULT '[]'::jsonb;
