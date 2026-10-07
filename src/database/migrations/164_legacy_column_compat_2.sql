-- More compatibility aliases for admin/analytics queries written against older names.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id UUID GENERATED ALWAYS AS (customer_id) STORED;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_id UUID;
ALTER TABLE products ADD COLUMN IF NOT EXISTS thumbnail TEXT GENERATED ALWAYS AS (thumbnail_url) STORED;
