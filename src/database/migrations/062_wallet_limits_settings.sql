-- 062_wallet_limits_settings.sql
-- Seed app_settings keys that cap wallet balances and wallet-to-wallet
-- transfers, both admin-configurable from the dashboard's Wallet Settings
-- page. ON CONFLICT DO NOTHING so any value an admin already saved is
-- preserved.
--
-- Also adds a varchar_pattern_ops index on users.phone so the new
-- recipient-search endpoint's prefix lookup (`phone LIKE $1 || '%'`) is
-- guaranteed to use an index scan regardless of the database's collation
-- (a plain btree only serves LIKE-prefix queries under a "C" locale).

INSERT INTO app_settings (key, value, description) VALUES
  ('wallet_max_balance',          '2000', 'Maximum total balance a single wallet may hold'),
  ('wallet_max_transfer_amount',  '2000', 'Maximum amount allowed in a single wallet-to-wallet transfer'),
  ('wallet_min_transfer_amount',  '1',    'Minimum amount allowed in a single wallet-to-wallet transfer')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_users_phone_pattern ON users (phone varchar_pattern_ops);
