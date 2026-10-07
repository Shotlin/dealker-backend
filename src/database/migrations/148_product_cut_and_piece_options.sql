-- Migration 148: customer-facing "Choose Your Cut" / "Available Pieces" options
--
-- Same-SKU, admin-authored, purely descriptive lists — NOT a different-SKU
-- variant system (that's product_families/product_variants, migration 048).
-- Admin types free-text options (e.g. cut_options: ["Tikka","Curry Cut",
-- "Boneless","Small Cubes"], piece_options: ["Small","Medium","Large"]) via
-- a tag-input in the dashboard; mobile renders them as selectable UI only
-- when non-empty. No price/stock/SKU impact — matches the existing
-- custom_badges JSONB-array convention (migration 048), not a rigid enum,
-- since real cut/piece vocabulary varies per meat type and per admin.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cut_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS piece_options JSONB NOT NULL DEFAULT '[]'::jsonb;
