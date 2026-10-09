-- 188_sell_request_evidence_qc.sql
-- Sell/Exchange request evidence (photos + QC video) and request-level QC.
-- Additive & idempotent. Historical requests (images JSONB, no media rows, no QC row) keep working.
--
-- Request media is deliberately NOT stored in the listing/product media tables: it is private
-- customer/device evidence, owned by the request, served only through authenticated or short-lived
-- signed URLs, and never deleted once attached to a request.

-- ── Admin-configurable limits + QC gate ─────────────────────────────────
ALTER TABLE sell_settings
  ADD COLUMN IF NOT EXISTS max_videos INTEGER NOT NULL DEFAULT 2 CHECK (max_videos BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS max_image_mb INTEGER NOT NULL DEFAULT 12 CHECK (max_image_mb BETWEEN 1 AND 25),
  ADD COLUMN IF NOT EXISTS max_video_mb INTEGER NOT NULL DEFAULT 100 CHECK (max_video_mb BETWEEN 5 AND 500),
  -- Off by default so existing approval behaviour is unchanged until an admin turns it on.
  ADD COLUMN IF NOT EXISTS qc_required_for_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Evidence files ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_request_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL DEFAULT 'SELL_REQUEST' CHECK (entity_type IN ('SELL_REQUEST')),
  entity_id UUID REFERENCES sell_requests(id) ON DELETE CASCADE,      -- NULL until the upload is claimed by a request
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO')),
  evidence_stage TEXT NOT NULL DEFAULT 'CUSTOMER_SUBMISSION'
    CHECK (evidence_stage IN ('CUSTOMER_SUBMISSION', 'PICKUP_INSPECTION', 'TECHNICIAN_QC', 'FINAL_QC', 'DISPUTE')),
  storage_key TEXT NOT NULL UNIQUE,                                   -- relative path inside private storage
  original_filename VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  checksum CHAR(64) NOT NULL,                                         -- sha256 of the stored bytes
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (uploaded_by_role IN ('CUSTOMER', 'ADMIN', 'VENDOR')),
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  verification_note VARCHAR(500),
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  CHECK ((entity_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_srm_entity ON sell_request_media (entity_id, created_at) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_srm_orphans ON sell_request_media (created_at) WHERE entity_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_srm_uploader ON sell_request_media (uploaded_by, created_at DESC);

-- Evidence attached to a request is immutable apart from its verification fields.
CREATE OR REPLACE FUNCTION sell_request_media_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.entity_id IS NOT NULL THEN
      RAISE EXCEPTION 'Evidence attached to a request cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.storage_key <> OLD.storage_key OR NEW.checksum <> OLD.checksum OR NEW.byte_size <> OLD.byte_size
     OR NEW.mime_type <> OLD.mime_type OR NEW.media_type <> OLD.media_type
     OR (OLD.entity_id IS NOT NULL AND NEW.entity_id IS DISTINCT FROM OLD.entity_id)
     OR (OLD.entity_id IS NOT NULL AND NEW.evidence_stage <> OLD.evidence_stage) THEN
    RAISE EXCEPTION 'Evidence files are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sell_request_media_guard ON sell_request_media;
CREATE TRIGGER trg_sell_request_media_guard BEFORE UPDATE OR DELETE ON sell_request_media
  FOR EACH ROW EXECUTE FUNCTION sell_request_media_guard();

-- ── Request-level QC (NOT listing QC: that one is keyed by shop_product_id) ─
CREATE TABLE IF NOT EXISTS sell_request_qc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL UNIQUE REFERENCES sell_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'AWAITING_EVIDENCE'
    CHECK (status IN ('AWAITING_EVIDENCE', 'EVIDENCE_UPLOADED', 'INSPECTION_PENDING', 'INSPECTION_COMPLETE', 'PASSED', 'RECHECK', 'FAILED')),
  inspector_id UUID REFERENCES users(id) ON DELETE SET NULL,
  physical_condition TEXT CHECK (physical_condition IN ('EXCELLENT', 'GOOD', 'FAIR', 'POOR')),
  imei_verified BOOLEAN,
  imei_observed VARCHAR(20),
  screen_condition TEXT CHECK (screen_condition IN ('FLAWLESS', 'MINOR_SCRATCHES', 'MAJOR_SCRATCHES', 'CRACKED', 'DEAD_PIXELS')),
  battery_health INTEGER CHECK (battery_health BETWEEN 0 AND 100),
  functionality JSONB NOT NULL DEFAULT '{}'::jsonb,                    -- {powersOn,touch,camera,speakers,...: boolean}
  remarks TEXT,
  final_valuation NUMERIC(10,2) CHECK (final_valuation IS NULL OR final_valuation >= 0),
  customer_decision TEXT NOT NULL DEFAULT 'NONE' CHECK (customer_decision IN ('NONE', 'PENDING', 'ACCEPTED', 'DECLINED')),
  customer_decided_at TIMESTAMPTZ,
  inspected_at TIMESTAMPTZ,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_srqc_status ON sell_request_qc (status);

-- Append-only approval history for the QC process.
CREATE TABLE IF NOT EXISTS sell_request_qc_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT,
  action TEXT NOT NULL,
  note TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_srqc_events_request ON sell_request_qc_events (request_id, id);

CREATE OR REPLACE FUNCTION sell_request_qc_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'QC history is append-only' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_srqc_events_append_only ON sell_request_qc_events;
CREATE TRIGGER trg_srqc_events_append_only BEFORE UPDATE ON sell_request_qc_events
  FOR EACH ROW EXECUTE FUNCTION sell_request_qc_events_append_only();

-- ── RBAC: dedicated QC permission (inspect / decide) ────────────────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['sell_requests.qc', 'exchange_requests.qc'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');
