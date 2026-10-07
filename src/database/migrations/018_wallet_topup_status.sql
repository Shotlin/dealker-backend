-- 018_wallet_topup_status.sql
-- Track pending/completed/failed wallet top-ups safely in wallet_transactions

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED';

CREATE INDEX IF NOT EXISTS idx_wallet_tx_reference_status
  ON wallet_transactions(reference_id, status);
