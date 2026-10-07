-- 085_order_notes.sql
--
-- Order-level internal admin notes — a running CRM-style thread on each
-- order (e.g. "customer asked for extra veggies"), independent of status
-- changes. The only existing note field, order_status_history.note,
-- requires a status transition (to_status NOT NULL) so it can't be used
-- for a standalone note. Multiple notes per order, oldest first.

CREATE TABLE IF NOT EXISTS order_notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  author_id   UUID REFERENCES users(id) NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_notes_order ON order_notes(order_id, created_at ASC);
