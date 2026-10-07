-- 160_bulk_catalog_import.sql
-- Marketplace bulk upload jobs (CSV/XLSX): upload → parse → validate →
-- preview → confirm → background apply → report. Bad rows never insert.

CREATE TABLE IF NOT EXISTS catalog_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(10) NOT NULL DEFAULT 'CSV' CHECK (file_type IN ('CSV', 'XLSX')),
  status TEXT NOT NULL DEFAULT 'VALIDATED'
    CHECK (status IN ('PARSING', 'VALIDATED', 'CONFIRMED', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'DISCARDED')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  warning_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'LISTINGS' CHECK (mode IN ('LISTINGS', 'PRODUCTS')),
  error_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_jobs_vendor ON catalog_import_jobs(vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS catalog_import_rows (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES catalog_import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  row_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID', 'WARNING', 'ERROR', 'IMPORTED', 'FAILED', 'SKIPPED')),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  listing_id UUID REFERENCES shop_products(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_rows_job ON catalog_import_rows(job_id, row_number);
CREATE INDEX IF NOT EXISTS idx_catalog_import_rows_status ON catalog_import_rows(job_id, status);

COMMENT ON TABLE catalog_import_jobs IS 'Preview-then-apply bulk importer (spec §18/§42). Apply only ever imports rows in VALID/WARNING state; failed rows are exportable.';
