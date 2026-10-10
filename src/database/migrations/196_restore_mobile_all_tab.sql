-- Repair for migration 194. It archived the Mobile "All" tab (the home layout that was being built
-- in the theme builder) because the old Marketplace "All" tab had the same key, and made the old
-- Marketplace tab the live default. This puts the Mobile tab back and archives the old one.
-- Nothing is deleted. Targeted + idempotent: it only acts when the live "All" tab is exactly the old
-- Marketplace tab and a richer archived Mobile "All" tab exists; otherwise it does nothing.
DO $$
DECLARE
  old_marketplace_all CONSTANT UUID := '3ca5fc69-138c-4c94-a696-95e787510d5b';
  restore_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theme_tabs
                  WHERE id = old_marketplace_all AND store_key = 'mobile' AND key = 'all' AND status = 'active') THEN
    RETURN;
  END IF;

  SELECT a.id INTO restore_id
    FROM theme_tabs a
   WHERE a.store_key = 'mobile' AND a.key = 'all' AND a.status = 'archived' AND a.id <> old_marketplace_all
     AND (SELECT count(*) FROM section_manifests s WHERE s.tab_id = a.id)
       > (SELECT count(*) FROM section_manifests s WHERE s.tab_id = old_marketplace_all)
   ORDER BY a.archived_at DESC NULLS LAST
   LIMIT 1;
  IF restore_id IS NULL THEN RETURN; END IF;

  UPDATE theme_tabs SET status = 'archived', archived_at = NOW(), is_default = FALSE WHERE id = old_marketplace_all;
  UPDATE theme_tabs SET status = 'active', archived_at = NULL, is_default = TRUE WHERE id = restore_id;
END $$;
