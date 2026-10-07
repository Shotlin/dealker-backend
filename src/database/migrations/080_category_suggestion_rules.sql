-- 080_category_suggestion_rules.sql
-- Admin-configurable "Pair With" cross-sell mapping between categories
-- (e.g. Dairy -> [Dairy, Bakery], Vegetables -> [Vegetables, Spices]).
--
-- Previously products.repository.js's findPairWith() had no concept of
-- category relevance at all — it just excluded the viewed product's own
-- category and sorted everything else by total_sold, so every product
-- showed the same global bestsellers-from-other-categories regardless of
-- what it actually was. A category with zero rows here falls back to that
-- exact previous behavior, so this ships with zero behavior change until
-- an admin explicitly configures a category from Settings -> Product
-- Suggestions.

CREATE TABLE IF NOT EXISTS category_suggestion_rules (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_category_id  UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  target_category_id  UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  display_order       INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_csr_source_target UNIQUE (source_category_id, target_category_id)
);

CREATE INDEX IF NOT EXISTS idx_csr_source ON category_suggestion_rules(source_category_id) WHERE is_active = true;
