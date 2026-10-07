-- Migration 099: Product Proposal Media Evidence, Variants & Specifications
-- Source of truth: Blueprint §06.2, Phase 3B

-- 1. Product Proposal Media Table
CREATE TABLE IF NOT EXISTS product_proposal_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES product_proposals(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO', 'PDF', 'CERTIFICATE', 'EVIDENCE_OTHER')),
  file_key VARCHAR(255) NOT NULL,
  file_url VARCHAR(512),
  mime_type VARCHAR(100),
  size BIGINT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_media_proposal ON product_proposal_media(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_media_sort ON product_proposal_media(proposal_id, sort_order ASC);

-- 2. Product Proposal Variants Table
CREATE TABLE IF NOT EXISTS product_proposal_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES product_proposals(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  target_price NUMERIC(10,2),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_proposal_variant_sku UNIQUE (proposal_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_proposal_variants_proposal ON product_proposal_variants(proposal_id);

-- 3. Product Proposal Specifications Table
CREATE TABLE IF NOT EXISTS product_proposal_specifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES product_proposals(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT NOT NULL,
  group_name VARCHAR(100) NOT NULL DEFAULT 'General',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_proposal_spec_key UNIQUE (proposal_id, key)
);

CREATE INDEX IF NOT EXISTS idx_proposal_specs_proposal ON product_proposal_specifications(proposal_id);

-- 4. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_proposal_media_updated_at ON product_proposal_media;
CREATE TRIGGER trg_proposal_media_updated_at
  BEFORE UPDATE ON product_proposal_media
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_proposal_variants_updated_at ON product_proposal_variants;
CREATE TRIGGER trg_proposal_variants_updated_at
  BEFORE UPDATE ON product_proposal_variants
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_proposal_specifications_updated_at ON product_proposal_specifications;
CREATE TRIGGER trg_proposal_specifications_updated_at
  BEFORE UPDATE ON product_proposal_specifications
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
