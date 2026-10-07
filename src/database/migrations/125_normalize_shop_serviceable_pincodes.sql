-- 125_normalize_shop_serviceable_pincodes.sql
--
-- Serviceability matches PINs by exact string equality
-- (`$1 = ANY(shops.serviceable_pincodes)`), so a duplicate or whitespace-padded
-- entry entered in the dashboard (e.g. "201301, 201301", " 201301") made the
-- stored list inconsistent. The API now normalises on write
-- (src/utils/pincode.js); this cleans rows written before that:
--   * strip ALL whitespace inside every entry
--   * drop blank entries
--   * de-duplicate, keeping the first-seen order
-- Idempotent: only rows whose list actually changes are touched, and
-- `updated_at` is left alone (this is a data repair, not a user edit).
-- Malformed-but-non-blank entries (e.g. a 5-digit value) are intentionally
-- NOT deleted; the dashboard now reports them so an admin can correct them.

WITH cleaned AS (
  SELECT s.id,
         COALESCE(
           (SELECT array_agg(x.pin ORDER BY x.first_pos)
              FROM (SELECT regexp_replace(t.entry, '\s', '', 'g') AS pin,
                           MIN(t.pos) AS first_pos
                      FROM unnest(s.serviceable_pincodes)
                           WITH ORDINALITY AS t(entry, pos)
                     WHERE regexp_replace(t.entry, '\s', '', 'g') <> ''
                     GROUP BY 1) x),
           '{}'::text[]
         ) AS pins
    FROM shops s
)
UPDATE shops s
   SET serviceable_pincodes = c.pins
  FROM cleaned c
 WHERE c.id = s.id
   AND s.serviceable_pincodes IS DISTINCT FROM c.pins;
