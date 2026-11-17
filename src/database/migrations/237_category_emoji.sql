-- 237: optional emoji for a category / product type.
-- Vendors can add product types (a top-level category) from the vendor app
-- with a name and an emoji or an image. Additive, nullable, no backfill:
-- existing rows and old clients are unaffected.
-- MUST be applied BEFORE deploying the code that selects categories.emoji.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS emoji VARCHAR(16);
