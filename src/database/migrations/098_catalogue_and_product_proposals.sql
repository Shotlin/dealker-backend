-- Migration 098: Catalogue Brands, Product Proposals & Approval Workflow
-- Source of truth: Blueprint §06.2, Phase 3A

-- 1. Brands Table
CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  logo_url VARCHAR(512),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brands_slug ON brands(slug);

-- 2. Vendor Product Proposals Table
CREATE TABLE IF NOT EXISTS product_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
  sku VARCHAR(100),
  description TEXT,
  unit VARCHAR(50) NOT NULL DEFAULT 'kg',
  target_price NUMERIC(10,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED', 'PUBLISHED', 'REJECTED')) DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_vendor_proposal_sku UNIQUE (vendor_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_proposals_vendor ON product_proposals(vendor_id);
CREATE INDEX IF NOT EXISTS idx_proposals_category ON product_proposals(category_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON product_proposals(status);

-- 3. Product Proposal Reviews History Table
CREATE TABLE IF NOT EXISTS product_proposal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES product_proposals(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('SUBMIT', 'START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CORRECTION', 'PUBLISH')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_reviews_proposal ON product_proposal_reviews(proposal_id);

-- 4. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_brands_updated_at ON brands;
CREATE TRIGGER trg_brands_updated_at
  BEFORE UPDATE ON brands
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_product_proposals_updated_at ON product_proposals;
CREATE TRIGGER trg_product_proposals_updated_at
  BEFORE UPDATE ON product_proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
