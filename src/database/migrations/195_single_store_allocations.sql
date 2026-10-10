-- Single-store mode: Dealker Official (the platform shop) serves all of India.
-- user_shop_allocations is a derived join table (recomputed from addresses), so it is
-- safe to realign it: every user is allocated to the platform shop only. New users get
-- the same row lazily on first read (AllocationService.getForUser). Skipped when no
-- active platform shop exists.
DO $$
DECLARE platform_id UUID;
BEGIN
  SELECT id INTO platform_id FROM shops
   WHERE is_platform = TRUE AND is_active = TRUE AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF platform_id IS NULL THEN RETURN; END IF;

  DELETE FROM user_shop_allocations WHERE shop_id <> platform_id;

  INSERT INTO user_shop_allocations (user_id, shop_id, distance_km, matched_pincode, is_primary)
  SELECT u.id, platform_id, NULL, NULL, TRUE FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM user_shop_allocations a WHERE a.user_id = u.id)
  ON CONFLICT (user_id, shop_id) DO NOTHING;

  UPDATE user_shop_allocations SET is_primary = TRUE WHERE shop_id = platform_id;
END $$;
