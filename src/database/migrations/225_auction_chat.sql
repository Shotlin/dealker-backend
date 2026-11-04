-- Seller ↔ winning buyer chat on an auction. A conversation exists once there is a winner and ends with the sale.
CREATE TABLE IF NOT EXISTS auction_messages (
  id BIGSERIAL PRIMARY KEY,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- the winner this thread belongs to (a re-offer starts a new thread)
  sender_role TEXT NOT NULL CHECK (sender_role IN ('BUYER', 'SELLER')),
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auction_messages_thread ON auction_messages (auction_id, buyer_id, id);
