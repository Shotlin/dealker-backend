-- 226_order_packing_invoices.sql
-- The seller's own sales invoice for an order, uploaded at packing time. Required before a vendor can
-- mark an order packed or shipped (marketplace seller_orders: B2C, wholesale, auction, used devices;
-- and requirement-based b2b_orders). The file lives in private storage and is streamed through an
-- authenticated endpoint. Additive and idempotent.

ALTER TABLE seller_orders
  ADD COLUMN IF NOT EXISTS invoice_file_path TEXT,
  ADD COLUMN IF NOT EXISTS invoice_file_name TEXT,
  ADD COLUMN IF NOT EXISTS invoice_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS invoice_uploaded_at TIMESTAMPTZ;

ALTER TABLE b2b_orders
  ADD COLUMN IF NOT EXISTS invoice_file_path TEXT,
  ADD COLUMN IF NOT EXISTS invoice_file_name TEXT,
  ADD COLUMN IF NOT EXISTS invoice_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS invoice_uploaded_at TIMESTAMPTZ;
