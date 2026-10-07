-- Migration 103: Quality Inspection Evidence, Defects & Dispositions
-- Source of truth: Blueprint §06.4, Phase 5B

-- 1. Quality Inspection Media Table
CREATE TABLE IF NOT EXISTS quality_inspection_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_inspection_id UUID NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO', 'PDF', 'CERTIFICATE', 'INSPECTION_REPORT')),
  file_key VARCHAR(255) NOT NULL,
  file_url VARCHAR(512),
  mime_type VARCHAR(100),
  size BIGINT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'GENERAL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_media_inspection ON quality_inspection_media(quality_inspection_id);

-- 2. Quality Defects Table
CREATE TABLE IF NOT EXISTS quality_defects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_inspection_id UUID NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'LOW',
  description TEXT,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_defects_inspection ON quality_defects(quality_inspection_id);

-- 3. Quality Corrective Actions Table
CREATE TABLE IF NOT EXISTS quality_corrective_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  defect_id UUID NOT NULL REFERENCES quality_defects(id) ON DELETE CASCADE,
  action_plan TEXT NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_actions_defect ON quality_corrective_actions(defect_id);

-- 4. Quality Dispositions Table
CREATE TABLE IF NOT EXISTS quality_dispositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_inspection_id UUID NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW', 'ACCEPT', 'REWORK', 'RETURN', 'REJECT')) DEFAULT 'PENDING_REVIEW',
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_dispositions_inspection ON quality_dispositions(quality_inspection_id);

-- 5. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_qc_media_updated_at ON quality_inspection_media;
CREATE TRIGGER trg_qc_media_updated_at
  BEFORE UPDATE ON quality_inspection_media
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_qc_defects_updated_at ON quality_defects;
CREATE TRIGGER trg_qc_defects_updated_at
  BEFORE UPDATE ON quality_defects
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_qc_actions_updated_at ON quality_corrective_actions;
CREATE TRIGGER trg_qc_actions_updated_at
  BEFORE UPDATE ON quality_corrective_actions
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_qc_dispositions_updated_at ON quality_dispositions;
CREATE TRIGGER trg_qc_dispositions_updated_at
  BEFORE UPDATE ON quality_dispositions
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
