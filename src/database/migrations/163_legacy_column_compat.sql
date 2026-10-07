-- Compatibility aliases: many admin/dashboard/report queries still read the
-- pre-migration-106 names. Read-only generated columns keep them working.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2) GENERATED ALWAYS AS (total_payable) STORED;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS total NUMERIC(10,2) GENERATED ALWAYS AS (subtotal) STORED;
