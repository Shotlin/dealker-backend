-- 178_qc_and_invoices.sql
-- Product QC (manual + rule-based automatic) and seller purchase-invoice
-- management. Both hang off the listing (shop_products row). Additive and
-- idempotent.

-- ── 1. IMEI on the product (serial_number already exists) ─────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS imei TEXT;

-- ── 2. QC state on the listing ────────────────────────────────────────────
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS qc_status TEXT NOT NULL DEFAULT 'QC_PENDING'
    CHECK (qc_status IN ('QC_PENDING', 'QC_PASSED', 'QC_FAILED', 'QC_RECHECK')),
  ADD COLUMN IF NOT EXISTS qc_mode TEXT CHECK (qc_mode IN ('MANUAL', 'AUTO')),
  ADD COLUMN IF NOT EXISTS qc_score INTEGER CHECK (qc_score IS NULL OR (qc_score BETWEEN 0 AND 100)),
  ADD COLUMN IF NOT EXISTS qc_notes TEXT,
  ADD COLUMN IF NOT EXISTS qc_checked_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS qc_checked_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shop_products_qc ON shop_products(qc_status) WHERE deleted_at IS NULL;

-- Append-only QC history: every decision, who/what made it, and the rule results.
CREATE TABLE IF NOT EXISTS listing_qc_events (
  id BIGSERIAL PRIMARY KEY,
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('MANUAL', 'AUTO', 'RESET')),
  score INTEGER,
  notes TEXT,
  results JSONB,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_qc_events_listing ON listing_qc_events(shop_product_id, created_at DESC);

-- ── 3. Automatic QC rules + settings ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS qc_rules (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  required BOOLEAN NOT NULL DEFAULT FALSE,   -- a failed required rule always fails QC
  weight INTEGER NOT NULL DEFAULT 10 CHECK (weight BETWEEN 0 AND 100),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO qc_rules (key, label, description, enabled, required, weight, params, sort_order) VALUES
  ('IMEI', 'IMEI verification',
   'Phones and tablets need a valid 15-digit IMEI (Luhn check) that matches the invoice.',
   TRUE, TRUE, 20, '{"categoryKeywords": ["phone", "mobile", "tablet", "smartphone"]}', 1),
  ('IMAGES', 'Product images', 'Minimum number of photos on the listing.',
   TRUE, TRUE, 15, '{"minImages": 3}', 2),
  ('INVOICE', 'Invoice check', 'A purchase invoice has been uploaded and verified by an admin.',
   TRUE, FALSE, 20, '{"requireVerified": true, "skipForNew": false}', 3),
  ('CONDITION', 'Condition details', 'Used / refurbished items describe their condition.',
   TRUE, FALSE, 10, '{"minNoteLength": 10}', 4),
  ('PRICE_RANGE', 'Price range', 'Selling price is a sensible share of the MRP.',
   TRUE, FALSE, 10, '{"minPctOfMrp": 30, "maxPctOfMrp": 100}', 5),
  ('REQUIRED_DOCUMENTS', 'Required documents', 'Invoice uploaded and warranty details filled in.',
   TRUE, FALSE, 10, '{"requireInvoice": true, "requireWarranty": true}', 6),
  ('SERIAL_NUMBER', 'Serial number', 'Serial number present on the listing.',
   TRUE, FALSE, 5, '{"minLength": 4}', 7),
  ('SELLER_INFO', 'Seller information', 'The seller account is verified and active.',
   TRUE, FALSE, 10, '{}', 8)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS qc_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_qc_enabled BOOLEAN NOT NULL DEFAULT TRUE,        -- run auto QC when a listing/invoice changes
  pass_threshold INTEGER NOT NULL DEFAULT 80 CHECK (pass_threshold BETWEEN 1 AND 100),
  require_pass_to_publish BOOLEAN NOT NULL DEFAULT FALSE, -- approval refuses non-passed listings
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO qc_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 4. Seller purchase invoices ───────────────────────────────────────────
-- Files live in private storage (never under the public /uploads tree) and
-- are streamed through authenticated endpoints.
CREATE TABLE IF NOT EXISTS listing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  invoice_number VARCHAR(60) NOT NULL,
  invoice_date DATE NOT NULL,
  purchase_amount NUMERIC(12,2) NOT NULL CHECK (purchase_amount > 0),
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  supplier_name VARCHAR(200),
  imei_serial VARCHAR(100),
  file_path TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(60) NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  sha256 CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'VERIFIED', 'REJECTED')),
  rejection_reason TEXT,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMP,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_invoices_listing ON listing_invoices(shop_product_id);
CREATE INDEX IF NOT EXISTS idx_listing_invoices_vendor ON listing_invoices(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_invoices_status ON listing_invoices(status, created_at DESC);
-- The same invoice number + IMEI/serial from one seller can only be live once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_invoices_live
  ON listing_invoices (COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       lower(invoice_number), COALESCE(lower(imei_serial), ''))
  WHERE status <> 'REJECTED';

-- A verified invoice is permanent: it can't be deleted and its evidence
-- (file, numbers, amounts) can't be altered.
CREATE OR REPLACE FUNCTION listing_invoices_lock_verified() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'VERIFIED' THEN
      RAISE EXCEPTION 'A verified invoice is permanent and cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VERIFIED' AND (
       NEW.status <> 'VERIFIED' OR NEW.file_path <> OLD.file_path OR NEW.sha256 <> OLD.sha256
    OR NEW.invoice_number <> OLD.invoice_number OR NEW.invoice_date <> OLD.invoice_date
    OR NEW.purchase_amount <> OLD.purchase_amount OR NEW.gst_amount <> OLD.gst_amount
    OR NEW.shop_product_id <> OLD.shop_product_id OR NEW.imei_serial IS DISTINCT FROM OLD.imei_serial
  ) THEN
    RAISE EXCEPTION 'A verified invoice is permanent and cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_invoices_lock ON listing_invoices;
CREATE TRIGGER trg_listing_invoices_lock
  BEFORE UPDATE OR DELETE ON listing_invoices
  FOR EACH ROW EXECUTE FUNCTION listing_invoices_lock_verified();

-- ── 5. Permissions ────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['qc.view','qc.manage','qc.settings','invoices.view','invoices.manage'])))
   )
 WHERE name IN ('Platform Admin', 'Catalog Manager');

COMMENT ON TABLE listing_invoices IS 'Seller purchase invoices mapped to a listing. Files in private storage; verified rows are immutable.';
COMMENT ON TABLE listing_qc_events IS 'Append-only QC decision history (manual, automatic, reset).';
