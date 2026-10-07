-- Closes the "which exact SKU" gap the user flagged: a procurement request
-- item was tied to a category + free-text name only — `product_id` was
-- optional and, even when set, was never copied forward into
-- `procurement_supply_order_items` by either the fixed-offer accept path
-- or the RFQ award path (that table had no such column at all). Staff
-- therefore had to re-pick the product from scratch, from an unfiltered
-- list, at receiving time every single time, with no link back to what
-- was actually requested. `product_id` on the request item is now
-- required going forward (app-layer schema, see vendor-procurement.schema.js)
-- and this column lets it survive award → supply order → (as a fallback)
-- the receipt line, so receiving can pre-fill instead of re-guess.
ALTER TABLE procurement_supply_order_items
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
