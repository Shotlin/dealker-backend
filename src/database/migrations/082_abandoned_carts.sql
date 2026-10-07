-- 082_abandoned_carts.sql
--
-- Abandoned Cart Management System.
--
-- The live shopping cart has no SQL table at all — it lives entirely in
-- Redis (cart:{userId}, 7-day sliding TTL, see cart.repository.js) with no
-- persisted history. These tables are NOT a mirror of Redis; they only
-- record a snapshot at the moment a cart crosses the inactivity threshold
-- (10 min, src/constants/abandonedCart.js), so the data survives even
-- after the Redis key expires or the underlying products/shops change.
--
-- abandoned_carts: one row per "abandonment episode" for a user. At most
-- one OPEN episode per user at a time (enforced by the partial unique
-- index below) — a user going idle, coming back, and going idle again
-- just refreshes the same OPEN row until it resolves (RECOVERED /
-- CONVERTED / EXPIRED), at which point the next detection starts a fresh
-- episode.
--
-- abandoned_cart_items: line-item snapshot (name/image/price at the time
-- of abandonment) since Redis only stores {productId, shopId, quantity} —
-- no display data — and products can be edited or deleted afterward.
--
-- abandoned_cart_notifications / abandoned_cart_coupons: link an episode
-- to the app's REAL notification/coupon systems (notifications,
-- notification_templates, coupons) — no parallel engine is introduced.

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','RECOVERED','CONVERTED','EXPIRED')),
  abandoned_at          TIMESTAMPTZ NOT NULL,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  item_count            INTEGER NOT NULL DEFAULT 0,
  total_quantity        INTEGER NOT NULL DEFAULT 0,
  cart_value            DECIMAL(10,2) NOT NULL DEFAULT 0,
  priority_score        DECIMAL(6,2) NOT NULL DEFAULT 0,
  priority_breakdown    JSONB DEFAULT '{}',
  recovered_at          TIMESTAMPTZ,
  converted_at          TIMESTAMPTZ,
  converted_order_id    UUID REFERENCES orders(id),
  expired_at            TIMESTAMPTZ,
  last_reminder_sent_at TIMESTAMPTZ,
  reminder_count        INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one open (unresolved) episode per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_abandoned_carts_open_user
  ON abandoned_carts(user_id) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status
  ON abandoned_carts(status, abandoned_at DESC);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_priority
  ON abandoned_carts(priority_score DESC) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_user
  ON abandoned_carts(user_id);

CREATE TABLE IF NOT EXISTS abandoned_cart_items (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  abandoned_cart_id      UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  product_id             UUID REFERENCES products(id) ON DELETE SET NULL,
  shop_id                UUID REFERENCES shops(id) ON DELETE SET NULL,
  product_name           VARCHAR(255) NOT NULL,
  product_thumbnail_url  TEXT,
  product_unit           VARCHAR(50),
  quantity               INTEGER NOT NULL CHECK (quantity > 0),
  unit_price             DECIMAL(10,2) NOT NULL,
  list_price             DECIMAL(10,2) NOT NULL,
  line_total             DECIMAL(10,2) NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_items_cart
  ON abandoned_cart_items(abandoned_cart_id);

CREATE TABLE IF NOT EXISTS abandoned_cart_events (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  abandoned_cart_id  UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  event_type         VARCHAR(30) NOT NULL CHECK (event_type IN
                        ('DETECTED','RESWEPT','RECOVERED','CONVERTED','EXPIRED','REMINDER_SENT','COUPON_ISSUED')),
  actor_type         VARCHAR(20) NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM','ADMIN','CUSTOMER')),
  actor_id           UUID REFERENCES users(id),
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_events_cart
  ON abandoned_cart_events(abandoned_cart_id, created_at DESC);

CREATE TABLE IF NOT EXISTS abandoned_cart_notifications (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  abandoned_cart_id  UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  notification_id    UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  template_id        UUID REFERENCES notification_templates(id),
  sent_by            UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_notifications_cart
  ON abandoned_cart_notifications(abandoned_cart_id);

CREATE TABLE IF NOT EXISTS abandoned_cart_coupons (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  abandoned_cart_id  UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  coupon_id          UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  issued_by          UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_coupons_cart
  ON abandoned_cart_coupons(abandoned_cart_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_abandoned_cart_coupons_pair
  ON abandoned_cart_coupons(abandoned_cart_id, coupon_id);
