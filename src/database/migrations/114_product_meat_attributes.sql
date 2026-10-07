-- Migration 114: Meat-specific product attributes
--
-- This is a meat-selling platform, not a grocery store — Bakaloo's own
-- product schema has no fields for these since it's a generic grocery app.
-- Deliberate new addition (not a Bakaloo port): dedicated columns rather
-- than the generic `attributes` array, so the customer app can later filter
-- /sort by cut type directly.
--
-- cut_type stays a free varchar (not a rigid enum) — real cut types differ
-- a lot by meat (chicken: Curry Cut/Boneless/Whole/Breast/Wings/Mince;
-- mutton: Curry Cut/Boneless/Chops/Mince; fish: Whole/Fillet/Steaks/Curry
-- Cut) — same convention as the existing free-varchar `option_label` column.
-- piece_count is also free text (e.g. "8-10 pieces"), matching how real
-- meat e-commerce listings describe pack contents. skin_type gets a real
-- CHECK constraint (3 fixed values), same convention as the existing
-- food_type/origin_tag columns.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cut_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS piece_count VARCHAR(30),
  ADD COLUMN IF NOT EXISTS skin_type VARCHAR(20) NOT NULL DEFAULT 'NONE';

ALTER TABLE products
  ADD CONSTRAINT chk_products_skin_type
  CHECK (skin_type IN ('SKIN_ON', 'SKINLESS', 'NONE'));
