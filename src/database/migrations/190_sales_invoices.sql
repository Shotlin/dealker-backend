-- 190_sales_invoices.sql
-- Sales documents: tax invoices, bills of supply, credit notes, debit notes — B2C and B2B.
-- Additive. Does NOT touch listing_invoices (seller *purchase* invoices, migration 178).
--
-- Guarantees:
--  * numbers are gapless per (issuer, document type, channel, financial year): allocated under a row lock inside
--    the same transaction that stores the document, so a failed render never burns a number;
--  * an issued document is immutable (trigger): its snapshot, amounts and number can never change, and it can
--    never be deleted — mistakes are corrected with a credit note;
--  * the PDF is stored once, checksummed, in private storage, and every view/download is audited.

-- ── Platform legal details & defaults (singleton) ───────────────────────
CREATE TABLE IF NOT EXISTS invoice_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Used as the issuer when a sale is made by the platform itself, and as fallback display details.
  legal_name VARCHAR(200),
  gstin VARCHAR(15) CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan VARCHAR(10),
  address TEXT,
  state_code CHAR(2),
  email VARCHAR(160),
  phone VARCHAR(30),
  -- Defaults for repair invoices. Confirm the codes with your accountant before go-live.
  repair_service_sac VARCHAR(8) NOT NULL DEFAULT '9987',
  repair_parts_hsn VARCHAR(8) NOT NULL DEFAULT '8517',
  terms TEXT NOT NULL DEFAULT 'Goods/services once delivered are subject to the warranty and return policy of the seller.',
  footer TEXT NOT NULL DEFAULT 'This is a computer-generated document.',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO invoice_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Number series: one row per issuer / type / channel / financial year ─
CREATE TABLE IF NOT EXISTS sales_document_series (
  issuer_key TEXT NOT NULL,                                   -- vendor uuid, or 'PLATFORM'
  doc_type TEXT NOT NULL CHECK (doc_type IN ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  channel TEXT NOT NULL CHECK (channel IN ('B2C', 'B2B')),
  fy CHAR(5) NOT NULL CHECK (fy ~ '^[0-9]{2}-[0-9]{2}$'),     -- '26-27'
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (issuer_key, doc_type, channel, fy)
);

-- ── Documents ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  doc_number VARCHAR(20) NOT NULL,                           -- GST limit is 16 characters; headroom for custom prefixes
  fy CHAR(5) NOT NULL,
  seq INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('B2C', 'B2B')),
  issuer_key TEXT NOT NULL,
  issuer_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  source_type TEXT NOT NULL CHECK (source_type IN ('REPAIR', 'SELLER_ORDER', 'MANUAL')),
  source_id UUID,
  ref_document_id UUID REFERENCES sales_documents(id) ON DELETE RESTRICT,   -- credit/debit note → original invoice
  reason TEXT,

  issue_date DATE NOT NULL,
  due_date DATE,
  order_ref VARCHAR(60),
  po_reference VARCHAR(60),

  seller JSONB NOT NULL,                                     -- legal name, GSTIN, address, state code …
  buyer JSONB NOT NULL,
  place_of_supply CHAR(2) NOT NULL,
  pos_assumed BOOLEAN NOT NULL DEFAULT FALSE,                -- recipient state unknown → supplier's state used
  supply_type TEXT NOT NULL CHECK (supply_type IN ('INTRA', 'INTER')),
  lines JSONB NOT NULL,                                      -- fully computed lines (snapshot)
  tax_summary JSONB NOT NULL,                                -- per HSN/SAC and rate
  taxable_total NUMERIC(14,2) NOT NULL,
  cgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  round_off NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1 AND 1),   -- paise-level difference vs the amount actually charged
  grand_total NUMERIC(14,2) NOT NULL CHECK (grand_total >= 0),
  payments JSONB NOT NULL DEFAULT '[]'::jsonb,               -- payments known at issue time (informational)
  notes TEXT,
  terms TEXT,
  -- E-invoicing is not integrated: no IRN or QR code is ever fabricated.
  irn TEXT,
  irn_status TEXT NOT NULL DEFAULT 'NOT_INTEGRATED' CHECK (irn_status IN ('NOT_INTEGRATED', 'NOT_REQUIRED', 'GENERATED')),

  pdf_key TEXT,
  pdf_checksum CHAR(64),
  pdf_bytes INTEGER,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (issuer_key, doc_number),
  UNIQUE (issuer_key, doc_type, channel, fy, seq),
  CHECK (doc_type NOT IN ('CREDIT_NOTE', 'DEBIT_NOTE') OR ref_document_id IS NOT NULL),
  CHECK (taxable_total >= 0)
);
-- One invoice per source object: issuing twice returns the first one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_doc_source ON sales_documents (source_type, source_id)
  WHERE source_id IS NOT NULL AND doc_type IN ('TAX_INVOICE', 'BILL_OF_SUPPLY');
CREATE INDEX IF NOT EXISTS idx_sales_doc_channel_date ON sales_documents (channel, issue_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_doc_issuer ON sales_documents (issuer_vendor_id, created_at DESC) WHERE issuer_vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_doc_buyer ON sales_documents (buyer_user_id, created_at DESC) WHERE buyer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_doc_ref ON sales_documents (ref_document_id) WHERE ref_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_doc_search ON sales_documents
  USING gin ((doc_number || ' ' || COALESCE(order_ref, '') || ' ' || COALESCE(po_reference, '') || ' ' || (buyer ->> 'name') || ' ' || COALESCE(buyer ->> 'businessName', '')) gin_trgm_ops);

-- Immutable once issued. The only permitted change is attaching the rendered PDF exactly once.
CREATE OR REPLACE FUNCTION sales_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Issued sales documents cannot be deleted — issue a credit note instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.pdf_key IS NULL AND NEW.pdf_key IS NOT NULL
     AND (to_jsonb(NEW) - 'pdf_key' - 'pdf_checksum' - 'pdf_bytes') = (to_jsonb(OLD) - 'pdf_key' - 'pdf_checksum' - 'pdf_bytes') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Issued sales documents are immutable — issue a credit note instead' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sales_documents_guard ON sales_documents;
CREATE TRIGGER trg_sales_documents_guard BEFORE UPDATE OR DELETE ON sales_documents FOR EACH ROW EXECUTE FUNCTION sales_documents_guard();

-- ── Audit trail (append-only) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_document_events (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES sales_documents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,                                        -- ISSUED, VIEWED, DOWNLOADED, CREDIT_NOTE_ISSUED, EXPORTED
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_doc_events ON sales_document_events (document_id, id);
CREATE OR REPLACE FUNCTION sales_doc_events_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'sales_document_events is append-only' USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sales_doc_events_append_only ON sales_document_events;
CREATE TRIGGER trg_sales_doc_events_append_only BEFORE UPDATE OR DELETE ON sales_document_events FOR EACH ROW EXECUTE FUNCTION sales_doc_events_append_only();

-- ── RBAC ────────────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['sales_invoices.view', 'sales_invoices.issue', 'sales_invoices.credit', 'sales_invoices.export', 'sales_invoices.settings'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');
