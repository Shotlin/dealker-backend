-- Admin-configurable order-lifecycle notifications. Until now every event's
-- title/message was hardcoded in customer-order-event.helper.js with no
-- way to edit the wording or turn an event off, and the mobile app already
-- had a home-screen "order tracking" banner (order_tracking_top_banner.dart)
-- built against a GET /notifications/event-flags endpoint that never
-- existed on the backend — this table plus the module built alongside it
-- is what actually backs that endpoint, and adds a second, independent
-- toggle for the banner (separate from whether the push/in-app
-- notification itself is sent) per the user's explicit "two different
-- lifecycle" request.
CREATE TABLE IF NOT EXISTS order_notification_settings (
  event_key VARCHAR(40) PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  notification_enabled BOOLEAN NOT NULL DEFAULT true,
  banner_enabled BOOLEAN NOT NULL DEFAULT true,
  image_url TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeded with the exact wording customer-order-event.helper.js already
-- hardcodes today, so shipping this migration changes nothing customers
-- see until an admin actually edits a row — ON CONFLICT DO NOTHING makes
-- re-running this migration (or a future one touching the same rows) safe.
INSERT INTO order_notification_settings (event_key, title, message) VALUES
  ('ORDER_PLACED', '🛍️ Order placed', 'Your order {{orderId}} was placed successfully. We will keep you updated here.'),
  ('CONFIRMED', '🎉 Order confirmed', 'Your order {{orderId}} has been confirmed.'),
  ('PREPARING', '🍳 Order being prepared', 'Your order {{orderId}} is being prepared.'),
  ('PACKED', '📦 Order packed', 'Your order {{orderId}} has been packed and is ready for pickup.'),
  ('RIDER_ACCEPTED', '🛵 Rider accepted your order', 'A delivery partner accepted order {{orderId}}. Please wait a few minutes while they get ready.'),
  ('PICKED_UP', '🚴 Out for delivery', 'Order {{orderId}} is on its way!'),
  ('OTP_RESENT', '🔑 Your delivery OTP', 'Your delivery OTP for order {{orderId}} is {{otp}}. Share it with your delivery partner to confirm delivery.'),
  ('DELIVERED', '✅ Delivered successfully', 'Order {{orderId}} has been delivered. Enjoy your purchase.'),
  ('CANCELLED', '❌ Order cancelled', 'Order {{orderId}} was cancelled.'),
  ('REFUNDED', '💰 Refund processed', 'Your refund for order {{orderId}} has been processed.')
ON CONFLICT (event_key) DO NOTHING;
