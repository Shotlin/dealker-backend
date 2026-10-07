-- Distinguish "deleted" from "manually deactivated" for products.
-- Until now, deleting a product just set is_active = false — the same
-- flag used when an admin manually toggles a product off. That made a
-- deleted product reappear forever under the "Inactive" status filter
-- (and under "All Status"), so deletes looked like they didn't work.

ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
