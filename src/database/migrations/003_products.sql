-- 003_products.sql
-- Products with full-text search support

CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(300) UNIQUE NOT NULL,
  description     TEXT,
  price           DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  sale_price      DECIMAL(10,2) CHECK (sale_price >= 0),
  cost_price      DECIMAL(10,2),
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
  stock_quantity  INTEGER DEFAULT 0 CHECK (stock_quantity >= 0),
  unit            VARCHAR(20) DEFAULT 'piece',
  thumbnail_url   TEXT,
  images          JSONB DEFAULT '[]',
  tags            TEXT[],
  is_active       BOOLEAN DEFAULT true,
  is_featured     BOOLEAN DEFAULT false,
  total_sold      INTEGER DEFAULT 0,
  search_vector   TSVECTOR,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_products_category  ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active    ON products(is_active, price);
CREATE INDEX IF NOT EXISTS idx_products_featured  ON products(is_featured) WHERE is_featured = true;
CREATE INDEX IF NOT EXISTS idx_products_stock     ON products(stock_quantity);
CREATE INDEX IF NOT EXISTS idx_products_search    ON products USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_products_tags      ON products USING GIN(tags);

-- Auto-update search vector on insert/update
CREATE OR REPLACE FUNCTION update_product_search()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector = to_tsvector('english', NEW.name || ' ' || COALESCE(NEW.description, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_search_update ON products;
CREATE TRIGGER product_search_update
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_product_search();
