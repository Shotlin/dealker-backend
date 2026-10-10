-- Marketplace storefront is merged into Mobile: Mobile is now the default store and the only
-- place the "All / Mobile / Electronics ..." home tabs live. Nothing is deleted: Mobile tabs whose
-- key collides with a Marketplace tab (e.g. both have "all") are archived, Marketplace's win.
-- Other Mobile tabs are kept and listed after the merged ones.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theme_tabs WHERE store_key = 'marketplace') THEN
    RETURN;
  END IF;

  UPDATE theme_tabs m
     SET status = 'archived', archived_at = NOW(), is_default = FALSE
   WHERE m.store_key = 'mobile' AND m.status = 'active'
     AND EXISTS (SELECT 1 FROM theme_tabs k
                  WHERE k.store_key = 'marketplace' AND k.status = 'active' AND k.key = m.key);

  UPDATE theme_tabs SET sort_order = sort_order + 100
   WHERE store_key = 'mobile' AND status = 'active';

  UPDATE theme_tabs SET store_key = 'mobile', is_default = FALSE WHERE store_key = 'marketplace';

  -- Exactly one default tab for Mobile: prefer the "all" tab, else the first.
  UPDATE theme_tabs SET is_default = TRUE
   WHERE id = (SELECT id FROM theme_tabs WHERE store_key = 'mobile' AND status = 'active'
                ORDER BY (key = 'all') DESC, sort_order, created_at LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM theme_tabs WHERE store_key = 'mobile' AND status = 'active' AND is_default);

  UPDATE theme_analytics SET store_key = 'mobile' WHERE store_key = 'marketplace';
END $$;
