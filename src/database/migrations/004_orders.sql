-- 004_orders.sql
-- Orders + order items

CREATE TYPE order_status AS ENUM (
  'PENDING', 'CONFIRMED', 'PREPARING',
  'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'CANCELLED', 'REFUNDED'
);

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number         VARCHAR(20) UNIQUE NOT NULL,
  user_id              UUID REFERENCES users(id) NOT NULL,
  rider_id             UUID REFERENCES users(id),
  delivery_partner_id  UUID REFERENCES users(id),
  status               order_status DEFAULT 'PENDING',
  items                JSONB NOT NULL,
  subtotal             DECIMAL(10,2) NOT NULL,
  discount_amount      DECIMAL(10,2) DEFAULT 0,
  delivery_fee         DECIMAL(10,2) DEFAULT 0,
  platform_fee         DECIMAL(10,2) DEFAULT 0,
  tax_amount           DECIMAL(10,2) DEFAULT 0,
  total_amount         DECIMAL(10,2) NOT NULL,
  payment_method       VARCHAR(50),
  payment_status       VARCHAR(20) DEFAULT 'PENDING',
  coupon_code          VARCHAR(50),
  delivery_address     JSONB NOT NULL,
  delivery_notes       TEXT,
  estimated_delivery   TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  proof_photo_url      TEXT,
  cancelled_reason     TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user             ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_rider            ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_partner ON orders(delivery_partner_id);
CREATE INDEX IF NOT EXISTS idx_orders_status           ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date             ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_number           ON orders(order_number);

-- Order items (denormalized snapshot — also stored in orders.items JSONB)
CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  product_id  UUID REFERENCES products(id),
  name        VARCHAR(255) NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit        VARCHAR(20),
  total       DECIMAL(10,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
