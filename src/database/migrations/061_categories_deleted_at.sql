-- Same issue as products: deleting a category only set is_active =
-- false, the same flag used for manual deactivation, so a deleted
-- category reappeared forever under "Inactive" in the admin tree.

ALTER TABLE categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
