-- Migration 112: "Opened" tracking for notification campaigns
-- (bakaloo: 117_notification_campaign_opens.sql, renumbered — 117 collides
-- with an unrelated meet-commerce migration)
--
-- notification_campaigns.opened_count exists but nothing ever increments
-- it, so the dashboard's Campaigns table always shows 0. The in-app
-- notifications table already gets one row per targeted user per campaign
-- (admin.notifications.repository createBulkNotifications), with
-- campaignId only inside the JSONB `data` blob — not queryable/indexable,
-- and not enough on its own for the app to report "this user opened this
-- campaign" without knowing the row's id.
--
-- Add a real campaign_id column so a tap can be attributed to (user,
-- campaign) directly, and derive opened_count live from
-- COUNT(is_read) instead of a counter nothing writes to.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES notification_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_campaign
  ON notifications(campaign_id) WHERE campaign_id IS NOT NULL;

-- Best-effort backfill for campaigns already sent before this migration —
-- their rows only have campaignId inside `data`.
UPDATE notifications
SET campaign_id = (data->>'campaignId')::uuid
WHERE campaign_id IS NULL
  AND data->>'campaignId' IS NOT NULL
  AND data->>'campaignId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
