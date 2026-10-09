-- 187_review_moderation.sql
-- Review moderation pipeline:  Submitted → Admin moderation → Approved → Published
-- (or Rejected / Hidden / Removed). Product reviews and vendor (shop) reviews
-- are separate. Only PUBLISHED reviews are shown to customers and counted in
-- ratings. Existing reviews are kept live (back-filled as PUBLISHED).

CREATE TABLE IF NOT EXISTS review_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_publish BOOLEAN NOT NULL DEFAULT FALSE,     -- skip moderation: new reviews go live straight away
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO review_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── product reviews ───────────────────────────────────────────────────────
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'REMOVED')),
  ADD COLUMN IF NOT EXISTS moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS moderation_note TEXT,
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reason TEXT,
  ADD COLUMN IF NOT EXISTS admin_reply TEXT,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS replied_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- everything that exists today is already visible to customers
UPDATE reviews SET status = 'PUBLISHED' WHERE status = 'SUBMITTED' AND moderated_at IS NULL AND created_at < NOW();
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product_published ON reviews(product_id) WHERE status = 'PUBLISHED';

-- ── vendor / shop reviews (separate from product reviews) ────────────────
CREATE TABLE IF NOT EXISTS vendor_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'REMOVED')),
  moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  moderated_at TIMESTAMP,
  moderation_note TEXT,
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reason TEXT,
  admin_reply TEXT,
  replied_at TIMESTAMP,
  replied_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, order_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_vendor ON vendor_reviews(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_status ON vendor_reviews(status, created_at DESC);

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS avg_rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;

-- ── reports raised by customers or vendors ───────────────────────────────
CREATE TABLE IF NOT EXISTS review_reports (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('PRODUCT', 'VENDOR')),
  review_id UUID NOT NULL,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (kind, review_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_review_reports_review ON review_reports(kind, review_id);

-- alert admins about new vendor reviews too (product reviews already do)
CREATE OR REPLACE FUNCTION trg_alert_vendor_review_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('NEW_REVIEW', 'New ' || NEW.rating || '★ vendor review · ' || (SELECT name FROM vendors WHERE id = NEW.vendor_id),
    LEFT(NEW.comment, 140), 'vendor_review', NEW.id::text, '/reviews', 'vreview:' || NEW.id, NULL, CASE WHEN NEW.rating <= 2 THEN 'WARNING' ELSE 'INFO' END);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_vendor_review_insert ON vendor_reviews;
CREATE TRIGGER trg_alert_vendor_review_insert AFTER INSERT ON vendor_reviews FOR EACH ROW EXECUTE FUNCTION trg_alert_vendor_review_insert();

UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['reviews.view','reviews.moderate'])))
   )
 WHERE name IN ('Platform Admin', 'Support Agent', 'Catalog Manager');
