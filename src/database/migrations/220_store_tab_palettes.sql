-- Home store-tab palettes: the four header colour sets (Mobile / Mobile Part / Accessories / Electronics)
-- measured from the design reference. Each set = header band, raised tab + panel, tab border, header text.
-- Merged into EVERY theme row (all tabs, A/B variants, shop overrides) so every section shows identical
-- colours. Keys are additive (`homeLook.storePalette{1..4}{Background,TabFill,TabEdge,Text}`) and editable
-- afterwards in Dashboard -> Theme builder -> Store tiles. The header/search backgrounds of the default
-- (first) palette are written too so the builder preview and any non-store header agree.
-- Idempotent: re-running just rewrites the same values. A new theme version is stored for each row so the
-- change can be rolled back from the dashboard.
DO $$
DECLARE
  palettes CONSTANT JSONB := '{
    "storePalette1Background": "#0A0115", "storePalette1TabFill": "#1C0442", "storePalette1TabEdge": "#F2E8FF", "storePalette1Text": "#FFFFFF",
    "storePalette2Background": "#DFE8FE", "storePalette2TabFill": "#E8F0FE", "storePalette2TabEdge": "#505A7A", "storePalette2Text": "#1B1E2B",
    "storePalette3Background": "#FEFCF8", "storePalette3TabFill": "#FCF6EC", "storePalette3TabEdge": "#5A5552", "storePalette3Text": "#2B2622",
    "storePalette4Background": "#000000", "storePalette4TabFill": "#02060C", "storePalette4TabEdge": "#FFFFFF", "storePalette4Text": "#FFFFFF"
  }'::jsonb;
  r RECORD;
  merged JSONB;
BEGIN
  FOR r IN SELECT id, version, theme_data FROM app_themes WHERE theme_data IS NOT NULL LOOP
    merged := r.theme_data;
    merged := jsonb_set(merged, '{sections}', COALESCE(merged -> 'sections', '{}'::jsonb), true);
    merged := jsonb_set(
      merged, '{sections,homeLook}',
      COALESCE(merged #> '{sections,homeLook}', '{}'::jsonb) || palettes, true);
    merged := jsonb_set(
      merged, '{sections,topBar}',
      COALESCE(merged #> '{sections,topBar}', '{}'::jsonb)
        || '{"backgroundColor": "#0A0115", "textColor": "#FFFFFF"}'::jsonb, true);
    merged := jsonb_set(
      merged, '{sections,searchZone}',
      COALESCE(merged #> '{sections,searchZone}', '{}'::jsonb)
        || '{"backgroundColor": "#1C0442", "waveColor": "#1C0442"}'::jsonb, true);

    CONTINUE WHEN merged = r.theme_data;

    UPDATE app_themes
       SET theme_data = merged,
           etag = md5(merged::text),
           version = COALESCE(version, 0) + 1,
           updated_at = NOW()
     WHERE id = r.id;

    INSERT INTO app_theme_versions (theme_id, version, theme_data, created_by)
    VALUES (r.id, COALESCE(r.version, 0) + 1, merged, NULL);
  END LOOP;
END $$;
