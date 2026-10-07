-- 128_widen_order_number.sql
--
-- `orders.order_number VARCHAR(20)` (migration 004) only ever had exactly
-- enough room for a 3-character `shops.order_prefix` ("FC-KOL-20260923-0001"
-- is 20 characters on the nose) — see 127's sibling fix in
-- orders.repository.js#generateCheckoutOrderNumber for the actual bug this
-- tightness caused (a date-formatting mistake made every order number
-- 22 characters and every single order placement fail). That fix also adds
-- a clear, actionable error instead of a raw DB overflow if a future
-- store's `order_prefix` is long enough to still exceed the column — but
-- this system is expanding to multiple named branches (Kolkata, Delhi, a
-- "Local" branch, ...), and a longer human-friendly prefix should never be
-- able to block order placement in the first place. VARCHAR(30) gives
-- headroom for a 13-character prefix ("FC-<prefix>-YYYYMMDD-NNNN"), comfortably
-- more than any realistic branch code.
--
-- Increasing a VARCHAR's length (or removing the limit) is a metadata-only
-- change in PostgreSQL — no table rewrite, safe on a live table of any size.

ALTER TABLE orders ALTER COLUMN order_number TYPE VARCHAR(30);
