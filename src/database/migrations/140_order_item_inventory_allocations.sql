-- Migration 140: Order Item Inventory Allocations
-- Links a sold order_item to the exact vendor-supplied inventory_lot(s) it
-- was fulfilled from (FEFO), so a customer's invoice QR can trace back to
-- the vendor's quality-video evidence for the batch actually sold to them.
-- Additive/best-effort: written by placeOrder only when a matching lot
-- exists for the shop's warehouse + product; absence of a row here never
-- blocks or fails an order.

CREATE TABLE IF NOT EXISTS order_item_inventory_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  inventory_lot_id UUID NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity_allocated NUMERIC(10,2) NOT NULL CHECK (quantity_allocated > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_item_allocations_order_item
  ON order_item_inventory_allocations(order_item_id);

CREATE INDEX IF NOT EXISTS idx_order_item_allocations_lot
  ON order_item_inventory_allocations(inventory_lot_id);
