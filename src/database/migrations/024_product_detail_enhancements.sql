-- 024_product_detail_enhancements.sql
-- Additional product detail fields for richer PDP and vendor metadata

ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS net_quantity VARCHAR(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS highlights JSONB DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(200);
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_address TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_fssai VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS return_policy VARCHAR(50) DEFAULT 'no_return';
ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_rating DECIMAL(2,1) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_authentic BOOLEAN DEFAULT true;
