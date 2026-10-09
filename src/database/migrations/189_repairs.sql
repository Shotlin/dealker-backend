-- 189_repairs.sql
-- Mobile / device repair management for B2C (single device) and B2B (bulk, PO, contract terms).
-- Additive & idempotent. Lifecycle is enforced in the service; money is computed server-side.

-- ── Settings (singleton) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repair_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  b2c_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  b2b_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  diagnostic_fee NUMERIC(10,2) NOT NULL DEFAULT 199 CHECK (diagnostic_fee >= 0),
  require_advance BOOLEAN NOT NULL DEFAULT TRUE,
  advance_pct NUMERIC(5,2) NOT NULL DEFAULT 30 CHECK (advance_pct BETWEEN 0 AND 100),
  -- GST on repair services/parts. Default 18% is a placeholder: confirm with your accountant before go-live.
  tax_pct NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (tax_pct BETWEEN 0 AND 40),
  platform_commission_pct NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (platform_commission_pct BETWEEN 0 AND 100),
  default_warranty_days INTEGER NOT NULL DEFAULT 90 CHECK (default_warranty_days BETWEEN 0 AND 730),
  estimate_validity_days INTEGER NOT NULL DEFAULT 7 CHECK (estimate_validity_days BETWEEN 1 AND 60),
  sla_inspection_hours INTEGER NOT NULL DEFAULT 24 CHECK (sla_inspection_hours BETWEEN 1 AND 720),
  sla_repair_hours INTEGER NOT NULL DEFAULT 72 CHECK (sla_repair_hours BETWEEN 1 AND 2160),
  max_b2c_devices INTEGER NOT NULL DEFAULT 3 CHECK (max_b2c_devices BETWEEN 1 AND 20),
  max_b2b_devices INTEGER NOT NULL DEFAULT 200 CHECK (max_b2b_devices BETWEEN 1 AND 1000),
  max_images INTEGER NOT NULL DEFAULT 10 CHECK (max_images BETWEEN 0 AND 30),
  max_videos INTEGER NOT NULL DEFAULT 2 CHECK (max_videos BETWEEN 0 AND 5),
  max_image_mb INTEGER NOT NULL DEFAULT 12 CHECK (max_image_mb BETWEEN 1 AND 25),
  max_video_mb INTEGER NOT NULL DEFAULT 100 CHECK (max_video_mb BETWEEN 5 AND 500),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO repair_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Service catalogue (labour price list) ───────────────────────────────
CREATE TABLE IF NOT EXISTS repair_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SCREEN','BATTERY','CHARGING','WATER_DAMAGE','SOFTWARE','CAMERA','AUDIO','BODY','BOARD','BIOMETRIC','DATA','OTHER')),
  device_category TEXT NOT NULL DEFAULT 'ANY' CHECK (device_category IN ('ANY','Smartphone','Tablet','Laptop')),
  labour_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (labour_price >= 0),
  est_hours INTEGER NOT NULL DEFAULT 24 CHECK (est_hours BETWEEN 1 AND 720),
  warranty_days INTEGER CHECK (warranty_days IS NULL OR warranty_days BETWEEN 0 AND 730),  -- NULL → settings default
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO repair_services (code, name, category, device_category, labour_price, est_hours) VALUES
  ('SCREEN_REPLACE', 'Screen / display replacement', 'SCREEN', 'ANY', 800, 24),
  ('BATTERY_REPLACE', 'Battery replacement', 'BATTERY', 'ANY', 500, 12),
  ('CHARGING_PORT', 'Charging port repair', 'CHARGING', 'ANY', 400, 24),
  ('WATER_DAMAGE', 'Water damage cleaning & treatment', 'WATER_DAMAGE', 'ANY', 1200, 72),
  ('BACK_GLASS', 'Back glass / panel replacement', 'BODY', 'Smartphone', 600, 24),
  ('CAMERA_MODULE', 'Camera module replacement', 'CAMERA', 'ANY', 600, 24),
  ('SPEAKER_MIC', 'Speaker / microphone repair', 'AUDIO', 'ANY', 350, 24),
  ('SOFTWARE_FIX', 'Software / OS reinstall', 'SOFTWARE', 'ANY', 300, 6),
  ('BIOMETRIC_FIX', 'Face ID / fingerprint repair', 'BIOMETRIC', 'Smartphone', 900, 48),
  ('BOARD_LEVEL', 'Motherboard / chip-level repair', 'BOARD', 'ANY', 2000, 120),
  ('DATA_RECOVERY', 'Data backup / recovery', 'DATA', 'ANY', 800, 48),
  ('KEYBOARD_REPLACE', 'Keyboard replacement', 'BODY', 'Laptop', 900, 48)
ON CONFLICT (code) DO NOTHING;

-- ── Business contract terms (B2B), matched by GSTIN ─────────────────────
CREATE TABLE IF NOT EXISTS repair_business_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gstin VARCHAR(15) NOT NULL UNIQUE CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  business_name VARCHAR(160) NOT NULL,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 60),
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 120),   -- 0 = pay before delivery
  credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Requests ────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS repair_request_seq START 200001;

CREATE TABLE IF NOT EXISTS repair_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('B2C', 'B2B')),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED','ACCEPTED','INSPECTION','ESTIMATE_SENT','ESTIMATE_APPROVED','IN_REPAIR','QC_PENDING','REPAIRED',
    'READY_FOR_DELIVERY','COMPLETED','REJECTED','CANCELLED','ESTIMATE_REJECTED','FAILED')),

  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (created_by_role IN ('CUSTOMER', 'ADMIN')),
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  customer_email VARCHAR(255),
  customer_city VARCHAR(100),

  -- B2B only
  business_name VARCHAR(160),
  gstin VARCHAR(15) CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  po_reference VARCHAR(60),
  contact_person VARCHAR(100),
  contract_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,

  service_mode TEXT NOT NULL DEFAULT 'DROP_OFF' CHECK (service_mode IN ('PICKUP', 'DROP_OFF')),
  pickup_address TEXT,
  pickup_slot TIMESTAMPTZ,
  description TEXT NOT NULL DEFAULT '',

  assigned_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,   -- service centre
  technician_id UUID REFERENCES users(id) ON DELETE SET NULL,
  technician_name VARCHAR(100),
  device_received_at TIMESTAMPTZ,

  -- money (all derived by the server from the approved quote)
  approved_quote_id UUID,
  approved_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (approved_total >= 0),
  advance_required NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (advance_required >= 0),
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  due_date DATE,
  commission_pct NUMERIC(5,2),
  commission_amount NUMERIC(12,2),
  vendor_payable NUMERIC(12,2),

  warranty_until DATE,
  rework_count INTEGER NOT NULL DEFAULT 0,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  sla_inspection_due TIMESTAMPTZ,
  sla_repair_due TIMESTAMPTZ,
  decision_note TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (channel <> 'B2B' OR (business_name IS NOT NULL AND gstin IS NOT NULL AND contact_person IS NOT NULL)),
  CHECK (service_mode <> 'PICKUP' OR pickup_address IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_repair_req_status ON repair_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_req_channel ON repair_requests (channel, status);
CREATE INDEX IF NOT EXISTS idx_repair_req_user ON repair_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_req_vendor ON repair_requests (assigned_vendor_id) WHERE assigned_vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repair_req_gstin ON repair_requests (gstin) WHERE gstin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repair_req_search ON repair_requests
  USING gin ((code || ' ' || customer_name || ' ' || customer_phone || ' ' || COALESCE(business_name, '') || ' ' || COALESCE(po_reference, '')) gin_trgm_ops);

-- ── Devices on a request (B2C: 1+, B2B: many) ───────────────────────────
CREATE TABLE IF NOT EXISTS repair_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'Smartphone' CHECK (category IN ('Smartphone', 'Tablet', 'Laptop', 'Other')),
  brand VARCHAR(60) NOT NULL,
  model VARCHAR(120) NOT NULL,
  imei_serial VARCHAR(30),
  problem_category TEXT NOT NULL CHECK (problem_category IN ('SCREEN','BATTERY','CHARGING','WATER_DAMAGE','SOFTWARE','CAMERA','AUDIO','BODY','BOARD','BIOMETRIC','DATA','OTHER')),
  problem_description TEXT NOT NULL DEFAULT '',
  warranty_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (warranty_status IN ('IN_WARRANTY', 'OUT_OF_WARRANTY', 'UNKNOWN')),
  accessories TEXT,
  item_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (item_status IN ('PENDING', 'REPAIRED', 'FAILED')),
  diagnosis TEXT,
  qc_passed BOOLEAN,
  qc_notes TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_repair_items_req ON repair_items (request_id);
CREATE INDEX IF NOT EXISTS idx_repair_items_imei ON repair_items (imei_serial) WHERE imei_serial IS NOT NULL;

-- ── Quotes (versioned; computed by the server) ──────────────────────────
CREATE TABLE IF NOT EXISTS repair_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'EXPIRED')),
  lines JSONB NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable NUMERIC(12,2) NOT NULL,
  tax_pct NUMERIC(5,2) NOT NULL,
  tax_amount NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  note TEXT,
  valid_until TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repair_quote_open ON repair_quotes (request_id) WHERE status IN ('SENT', 'APPROVED');

-- ── Payments (append-only, idempotent) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS repair_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('ADVANCE', 'BALANCE', 'DIAGNOSTIC', 'REFUND')),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'UPI', 'CARD', 'BANK', 'COD', 'WALLET')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(80),
  idempotency_key VARCHAR(80) NOT NULL,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_repair_pay_req ON repair_payments (request_id, created_at);

-- ── Timeline (append-only) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repair_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repair_events_req ON repair_events (request_id, id);

CREATE OR REPLACE FUNCTION repair_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_repair_events_append_only ON repair_events;
CREATE TRIGGER trg_repair_events_append_only BEFORE UPDATE OR DELETE ON repair_events FOR EACH ROW EXECUTE FUNCTION repair_append_only();
DROP TRIGGER IF EXISTS trg_repair_payments_append_only ON repair_payments;
CREATE TRIGGER trg_repair_payments_append_only BEFORE UPDATE OR DELETE ON repair_payments FOR EACH ROW EXECUTE FUNCTION repair_append_only();

-- ── Evidence (customer photos/videos, intake, diagnosis, progress, final QC, delivery) ──
CREATE TABLE IF NOT EXISTS repair_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES repair_requests(id) ON DELETE CASCADE,       -- NULL until attached
  item_id UUID REFERENCES repair_items(id) ON DELETE SET NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO')),
  evidence_stage TEXT NOT NULL DEFAULT 'CUSTOMER_SUBMISSION'
    CHECK (evidence_stage IN ('CUSTOMER_SUBMISSION', 'INTAKE', 'DIAGNOSIS', 'REPAIR_PROGRESS', 'FINAL_QC', 'DELIVERY', 'DISPUTE')),
  storage_key TEXT NOT NULL UNIQUE,
  original_filename VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  checksum CHAR(64) NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (uploaded_by_role IN ('CUSTOMER', 'ADMIN', 'VENDOR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  CHECK ((entity_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_repair_media_entity ON repair_media (entity_id, created_at) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repair_media_orphans ON repair_media (created_at) WHERE entity_id IS NULL;

CREATE OR REPLACE FUNCTION repair_media_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.entity_id IS NOT NULL THEN RAISE EXCEPTION 'Repair evidence cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.storage_key <> OLD.storage_key OR NEW.checksum <> OLD.checksum OR NEW.byte_size <> OLD.byte_size
     OR NEW.mime_type <> OLD.mime_type OR NEW.media_type <> OLD.media_type
     OR (OLD.entity_id IS NOT NULL AND (NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.evidence_stage <> OLD.evidence_stage)) THEN
    RAISE EXCEPTION 'Repair evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_repair_media_guard ON repair_media;
CREATE TRIGGER trg_repair_media_guard BEFORE UPDATE OR DELETE ON repair_media FOR EACH ROW EXECUTE FUNCTION repair_media_guard();

-- ── RBAC ────────────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['repairs.view', 'repairs.manage', 'repairs.settings', 'repairs.finance'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['repairs.view'])
           ) s)))
 WHERE name IN ('Marketing Manager', 'Catalog Manager')
   AND NOT (permissions ? '*');
