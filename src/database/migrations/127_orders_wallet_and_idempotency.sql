-- 127_orders_wallet_and_idempotency.sql
--
-- Two gaps found while wiring the cart's wallet toggle to a real charge:
--
-- 1. `orders.wallet_amount` / `orders.wallet_debited` — placeOrder() never
--    had anywhere to persist how much of an order was paid from wallet
--    balance, even though the mobile app has carried a `walletAmountUsed`
--    field on `PlacedOrderEntity`/`OrderEntity` (order_model.dart, both
--    checkout and orders features) for a while, always defaulting to 0
--    because the backend never sent it. `wallet_debited` tracks whether the
--    wallet slice has actually been taken yet — for COD (and a
--    wallet-fully-covers-the-total ONLINE order) it's debited atomically at
--    order-creation time and this is `true` immediately; for a *partial*
--    wallet + ONLINE order it stays `false` until payment is confirmed
--    (payments.service.js#verifyPayment / the Razorpay webhook), so a
--    cancelled/failed Razorpay attempt never had anything taken from the
--    wallet to roll back in the first place.
--
-- 2. `orders.client_order_ref` — a client-generated UUID sent once per
--    checkout attempt (mobile: generated when CheckoutNotifier.placeOrder()
--    starts a new attempt, reused only if that exact attempt is retried).
--    placeOrder() looks up this ref before doing any work; a retried
--    request (double-tap slipping past the client-side isPlacingOrder
--    guard, a dropped-response-but-delivered network retry) returns the
--    order(s) already created instead of creating duplicates or debiting
--    the wallet twice. The partial unique index only constrains rows that
--    actually carry a ref, so it's a no-op for every order placed by an
--    older app build that never sends one.
--
-- Purely additive: nullable/defaulted columns, one partial index.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet_amount DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet_debited BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_order_ref UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_client_ref
  ON orders (customer_id, client_order_ref)
  WHERE client_order_ref IS NOT NULL;

COMMENT ON COLUMN orders.wallet_amount IS
  'Rupee amount of this order paid from the customer wallet (min(balance, payable-after-coupon)). 0 when the wallet toggle was off.';
COMMENT ON COLUMN orders.wallet_debited IS
  'Whether wallet_amount has actually been debited yet — true immediately for COD/fully-wallet-covered orders, false until payment confirmation for a partial wallet + ONLINE order.';
COMMENT ON COLUMN orders.client_order_ref IS
  'Client-generated idempotency key for one checkout attempt — lets a retried placeOrder() request return the already-created order(s) instead of duplicating them.';
