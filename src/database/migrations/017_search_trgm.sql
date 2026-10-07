CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
ON products USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
ON products USING GIN (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm
ON products USING GIN (barcode gin_trgm_ops);
