-- Automatic cleanup of replaced / removed public images (banners, icons, product photos, avatars...).
--
-- Whenever a tracked column loses a Cloudinary (or local /uploads) URL — the image was replaced,
-- cleared, or its whole row deleted — the old URL is queued here. The API's media-cleanup sweeper
-- (src/modules/uploads/media-cleanup.js) deletes the file once nothing else still references it.
-- Doing this in the database covers every code path (admin, vendor, app, raw SQL) with no
-- per-service changes. Private files (KYC, invoices, proof photos, QC evidence) are NOT tracked.

CREATE TABLE IF NOT EXISTS media_deletion_queue (
  id          BIGSERIAL PRIMARY KEY,
  url         TEXT NOT NULL,
  source      TEXT NOT NULL,
  run_after   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 seconds',
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_deletion_queue_due ON media_deletion_queue (run_after);

-- Every column that may hold a public image URL. The sweeper scans all of these before deleting a
-- file, so an image shared by two rows (or kept in theme history) is never removed while in use.
CREATE TABLE IF NOT EXISTS media_tracked_columns (
  table_name   TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  PRIMARY KEY (table_name, column_name)
);

CREATE OR REPLACE FUNCTION queue_media_cleanup() RETURNS trigger AS $$
DECLARE
  col     TEXT;
  old_j   JSONB := to_jsonb(OLD);
  new_txt TEXT;
  u       TEXT;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_j->>col IS NULL THEN CONTINUE; END IF;
    new_txt := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(to_jsonb(NEW)->>col, '') ELSE '' END;
    FOR u IN
      SELECT DISTINCT m[1] FROM regexp_matches(old_j->>col, '(https?://[^"\s\\]+)', 'g') AS m
    LOOP
      IF (u ~ '^https?://res\.cloudinary\.com/' OR u ~ '/uploads/')
         AND position(u IN new_txt) = 0 THEN
        INSERT INTO media_deletion_queue (url, source) VALUES (u, TG_TABLE_NAME || '.' || col);
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  spec  TEXT[];
  t     TEXT;
  cols  TEXT[];
  c     TEXT;
  have  TEXT[];
  specs TEXT[][] := ARRAY[
    ['banners',                    'image_url'],
    ['categories',                 'image_url'],
    ['products',                   'images,thumbnail,thumbnail_url,brand_logo_url,video_url'],
    ['product_variants',           'image_url'],
    ['product_families',           'thumbnail_url'],
    ['brands',                     'logo_url'],
    ['shops',                      'logo_url,banner_url'],
    ['users',                      'avatar_url'],
    ['cart_milestones',            'icon_url'],
    ['payment_offers',             'icon_url'],
    ['app_themes',                 'tab_icon_url,theme_data'],
    ['app_theme_versions',         'theme_data'],
    ['theme_tabs',                 'image_url,merch_config'],
    ['section_manifests',          'config'],
    ['section_manifest_versions',  'snapshot'],
    ['storefront_stores',          'icon_url'],
    ['notification_campaigns',     'image_url'],
    ['notification_templates',     'image_url'],
    ['notifications',              'image_url'],
    ['order_notification_settings','image_url'],
    ['store_status',               'closed_banner_image_url'],
    ['auctions',                   'image_url,images'],
    ['app_settings',               'value'],
    ['tutorial_videos',            'video_url']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    t := spec[1];
    cols := string_to_array(spec[2], ',');
    have := ARRAY[]::TEXT[];
    FOREACH c IN ARRAY cols LOOP
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = t AND column_name = c) THEN
        have := have || c;
        INSERT INTO media_tracked_columns (table_name, column_name) VALUES (t, c) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;

    IF array_length(have, 1) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_media_cleanup_upd ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_media_cleanup_del ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_media_cleanup_upd AFTER UPDATE OF %s ON %I FOR EACH ROW EXECUTE FUNCTION queue_media_cleanup(%s)',
      (SELECT string_agg(quote_ident(x), ', ') FROM unnest(have) x), t,
      (SELECT string_agg(quote_literal(x), ', ') FROM unnest(have) x));
    EXECUTE format(
      'CREATE TRIGGER trg_media_cleanup_del AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION queue_media_cleanup(%s)',
      t, (SELECT string_agg(quote_literal(x), ', ') FROM unnest(have) x));
  END LOOP;
END $$;
