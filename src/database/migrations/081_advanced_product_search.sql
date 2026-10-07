-- 081_advanced_product_search.sql
-- Upgrades product search relevance: previously search_vector (migration
-- 003_products.sql) only indexed name + description, so a query matching a
-- product's category ("vegetables"), brand ("Amul"), or tags returned
-- nothing unless that same word also happened to appear in the name or
-- description. Also fixes a dictionary mismatch: the old trigger built
-- search_vector with the 'english' dictionary (stemming: "milks" -> "milk")
-- while products.repository.js's fullTextSearch() queries it with a
-- 'simple' dictionary tsquery (no stemming) — the two configs don't
-- reliably match each other's lexemes, so legitimate prefix searches could
-- silently miss. Both sides now consistently use 'simple'.
--
-- Field weights (A highest -> D lowest) make ts_rank/ts_rank_cd naturally
-- score a name/brand match higher than a category/tag match, and a
-- category/tag match higher than a plain description match.

CREATE OR REPLACE FUNCTION update_product_search()
RETURNS TRIGGER AS $$
DECLARE
  cat_name TEXT;
BEGIN
  SELECT name INTO cat_name FROM categories WHERE id = NEW.category_id;

  NEW.search_vector :=
    setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.brand, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(cat_name, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.meta_title, '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(NEW.meta_description, '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(NEW.description, '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_search_update ON products;
CREATE TRIGGER product_search_update
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_product_search();

-- A category rename doesn't touch the product row itself, so the trigger
-- above never fires for it — keep every affected product's search_vector
-- in sync by re-touching them whenever a category's name changes (cheap:
-- category renames are a rare admin action, not a hot path).
CREATE OR REPLACE FUNCTION resync_products_on_category_rename()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE products SET updated_at = updated_at WHERE category_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS category_rename_resync_products ON categories;
CREATE TRIGGER category_rename_resync_products
  AFTER UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION resync_products_on_category_rename();

-- Trigram index for brand — fuzzySuggest() now also matches on brand.
CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
ON products USING GIN (brand gin_trgm_ops);

-- Backfill: rebuild search_vector for every existing product using the new
-- weighted function. Setting a column to itself still fires the BEFORE
-- UPDATE trigger without changing updated_at or any other observable value.
UPDATE products SET updated_at = updated_at;
