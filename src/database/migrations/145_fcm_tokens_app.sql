-- Which FreshCuts app a push token belongs to. The customer app, vendor app
-- (and, later, a rider app) all register tokens against the same `users` row
-- when one phone number is used in more than one — without this a customer
-- campaign reached the vendor app and the "one active token per user" rule
-- meant the two apps kept knocking each other's token off.
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS app VARCHAR(20) NOT NULL DEFAULT 'customer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fcm_tokens_app'
  ) THEN
    ALTER TABLE fcm_tokens
      ADD CONSTRAINT chk_fcm_tokens_app CHECK (app IN ('customer', 'vendor', 'rider'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_app_active
  ON fcm_tokens(user_id, app)
  WHERE is_active = true;
