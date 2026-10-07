-- 012_wishlist.sql
-- User wishlist for products

CREATE TABLE IF NOT EXISTS wishlist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  product_id  UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_user_product ON wishlist(user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id);
