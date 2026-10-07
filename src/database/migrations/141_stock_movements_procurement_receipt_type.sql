-- Migration 141: stock_movements gains a PROCUREMENT_RECEIPT type
-- Closes the gap where a vendor's accepted supply-order receipt
-- (procurement_receipt_items, inventory_lots) never fed back into the
-- sellable shop_products.stock_quantity a customer actually buys against —
-- admins had to re-type the same quantity by hand via MANUAL_ADJUSTMENT,
-- with no ledger trace back to the vendor/receipt that produced it.
-- PROCUREMENT_RECEIPT is written by vendor-procurement.service.js#receiveSupply
-- (system/API-driven, source='API'), never by the dashboard's manual
-- adjust-stock endpoint (that stays MANUAL_ADJUSTMENT/DAMAGED_STOCK/RETURN_STOCK).

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movements_type;

ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movements_type CHECK (type IN (
  'MANUAL_ADJUSTMENT', 'ORDER_DEDUCTION', 'CANCELLATION_RESTORE',
  'DAMAGED_STOCK', 'RETURN_STOCK', 'PROCUREMENT_RECEIPT'
));
