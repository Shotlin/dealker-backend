-- 011_reviews.sql
-- Product reviews by verified buyers

CREATE TABLE IF NOT EXISTS reviews (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  product_id            UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  order_id              UUID REFERENCES orders(id) ON DELETE CASCADE,
  rating                INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment               TEXT,
  is_verified_purchase  BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- One review per user per product per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_order_product ON reviews(user_id, order_id, product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_user    ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating  ON reviews(product_id, rating);
