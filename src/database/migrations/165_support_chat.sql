-- Customer support chat: conversations (tickets), messages, activity events, canned replies.
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS refund_request_id UUID REFERENCES refund_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'APP',
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT,
  ADD COLUMN IF NOT EXISTS last_sender_type TEXT,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_unread INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_unread INTEGER NOT NULL DEFAULT 0;

ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_priority_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_priority_check
  CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'));
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_category_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_category_check
  CHECK (category IN ('GENERAL', 'ORDER', 'DELIVERY', 'RETURN_REFUND', 'PAYMENT', 'PRODUCT', 'ACCOUNT', 'SELLER'));

CREATE INDEX IF NOT EXISTS idx_support_tickets_inbox ON support_tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_order ON support_tickets (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_refund ON support_tickets (refund_request_id) WHERE refund_request_id IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS support_ticket_seq START 1000;

CREATE TABLE IF NOT EXISTS support_messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type  TEXT NOT NULL CHECK (sender_type IN ('CUSTOMER', 'AGENT', 'SYSTEM')),
  sender_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  is_internal  BOOLEAN NOT NULL DEFAULT false,
  attachments  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support_ticket_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('CREATED', 'ASSIGNED', 'STATUS', 'PRIORITY', 'CATEGORY')),
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  from_value  TEXT,
  to_value    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_events_ticket ON support_ticket_events (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support_canned_replies (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  category   TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO support_canned_replies (title, body, category, sort_order) VALUES
 ('Greeting', 'Hi {{name}}, thanks for contacting Dealker support. I''m looking into this for you right now.', NULL, 1),
 ('Need order details', 'Could you please share your order number and a short description of the issue? A photo helps if the item was damaged.', 'ORDER', 2),
 ('Return approved', 'Good news — your return request has been approved. The pickup will be scheduled within 2 working days and the refund will be processed after the item is received and checked.', 'RETURN_REFUND', 3),
 ('Return needs photos', 'To proceed with your return, please send clear photos of the product and its packaging, including the shipping label.', 'RETURN_REFUND', 4),
 ('Refund timeline', 'Refunds to the original payment method take 5–7 working days after approval. Wallet refunds are instant.', 'RETURN_REFUND', 5),
 ('Delivery delayed', 'Sorry for the delay with your delivery. I''ve checked with the courier and will update you as soon as I have a confirmed delivery date.', 'DELIVERY', 6),
 ('Payment failed', 'If money was deducted but the order was not placed, it is automatically refunded to your account within 5–7 working days.', 'PAYMENT', 7),
 ('Closing', 'Is there anything else I can help you with? If not, I''ll mark this conversation as resolved. Thanks for shopping with Dealker!', NULL, 8)
ON CONFLICT DO NOTHING;
