-- 051_notification_system_fixes.sql
-- Fix notification_templates missing columns, add image_url/deep_link/deep_link
-- to notifications table, add campaign scheduler support columns

-- ── notification_templates: add missing type + variables columns ──────────
ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'PUSH'
    CHECK (type IN ('PUSH', 'SMS', 'EMAIL', 'IN_APP'));

ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '[]';

ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- ── notifications (inbox): add image_url, deep_link, updated_at ──────────
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS deep_link TEXT;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── notification_campaigns: add missing/useful columns ───────────────────
ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS segment VARCHAR(50);

ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'general';

ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS failure_summary JSONB DEFAULT '{}';

ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── fcm_tokens: add is_active flag for invalid token cleanup ─────────────
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_active
  ON fcm_tokens(user_id, is_active)
  WHERE is_active = true;

-- ── Indexes for scheduled campaign poller ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nc_scheduled_due
  ON notification_campaigns(scheduled_at)
  WHERE status = 'SCHEDULED';
