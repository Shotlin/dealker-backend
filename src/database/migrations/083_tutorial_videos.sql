-- 083_tutorial_videos.sql
--
-- In-app tutorial video section. Admin pastes a YouTube link + title (+
-- optional language label, since the same walkthrough may be recorded in
-- multiple languages) from the dashboard; the customer app lists them and
-- plays each one embedded in-app (never redirecting out to the YouTube
-- app/browser). video_id is the extracted 11-char YouTube video ID, stored
-- alongside the raw pasted URL so the app can hand it straight to an
-- embedded player without re-parsing the URL client-side.

CREATE TABLE IF NOT EXISTS tutorial_videos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       VARCHAR(200) NOT NULL,
  video_url   TEXT NOT NULL,
  video_id    VARCHAR(20) NOT NULL,
  language    VARCHAR(50),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tutorial_videos_active_order
  ON tutorial_videos(is_active, sort_order);
