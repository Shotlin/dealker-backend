-- Migration 101: Procurement Comments, Evidence Categorization & Audit Timeline
-- Source of truth: Blueprint §06.3, Phase 4B

-- 1. Procurement Comments Table
CREATE TABLE IF NOT EXISTS procurement_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_comments_order ON procurement_comments(procurement_order_id);

-- 2. Enhance Procurement Media Table with Category & Sort Order
ALTER TABLE procurement_media ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'GENERAL';
ALTER TABLE procurement_media ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_procurement_media_cat_sort ON procurement_media(procurement_order_id, category, sort_order ASC);

-- 3. Enhance Procurement Audit Logs Table with Entity Type & Metadata
ALTER TABLE procurement_audit_logs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(100) NOT NULL DEFAULT 'PROCUREMENT_ORDER';
ALTER TABLE procurement_audit_logs ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE procurement_audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 4. Automatic Timestamp Trigger for Comments
DROP TRIGGER IF EXISTS trg_procurement_comments_updated_at ON procurement_comments;
CREATE TRIGGER trg_procurement_comments_updated_at
  BEFORE UPDATE ON procurement_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
