-- 118_wholesale_pricing.sql
-- B2B/wholesale price, admin-settable per product (master catalog default)
-- and per-shop (override) — mirrors the existing price/sale_price columns
-- on both tables. NULL means "no wholesale price set"; callers fall back to
-- the regular retail price in that case, same fallback rule the existing
-- shop_products.price -> products.price chain already uses.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(10,2)
    CHECK (wholesale_price IS NULL OR wholesale_price >= 0);

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(10,2)
    CONSTRAINT chk_shop_products_wholesale_price
    CHECK (wholesale_price IS NULL OR (wholesale_price >= 0.01 AND wholesale_price <= 99999999.99));
