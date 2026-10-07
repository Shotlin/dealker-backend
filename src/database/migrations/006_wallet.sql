-- 006_wallet.sql
-- Digital wallet + transaction history

CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) UNIQUE NOT NULL,
  balance     DECIMAL(10,2) DEFAULT 0 CHECK (balance >= 0),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

CREATE TYPE wallet_tx_type AS ENUM ('CREDIT', 'DEBIT');

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id     UUID REFERENCES wallets(id) NOT NULL,
  type          wallet_tx_type NOT NULL,
  amount        DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description   TEXT,
  reference_id  VARCHAR(100),
  balance_after DECIMAL(10,2),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_date   ON wallet_transactions(created_at DESC);
