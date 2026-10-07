-- `orders.status` had a DEFAULT but no NOT NULL constraint, so any write
-- path that omitted the column (or explicitly set it to NULL) could leave
-- a row with status = NULL. The admin dashboard's status badge falls back
-- to `{ label: order.status, ... }` for unrecognized statuses — for NULL
-- that renders as a bare colored dot with no text, which is what showed up
-- in the orders list. Backfill any existing NULLs to PENDING (the column
-- default, and the safest interpretation for an order stuck with no
-- status) and make the column NOT NULL so this can't recur.

UPDATE orders SET status = 'PENDING' WHERE status IS NULL;

ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
