-- 020_app_themes.sql
-- App themes table + initial Summer 2026 theme seed

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════
-- 1. APP THEMES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_themes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  is_active  BOOLEAN DEFAULT false,
  theme_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_theme
  ON app_themes(is_active)
  WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════
-- 2. SEED INITIAL THEME
-- ═══════════════════════════════════════════════════════════════
INSERT INTO app_themes (name, is_active, theme_data)
SELECT
  'Summer 2026',
  true,
  $theme$
  {
    "sections": {
      "topBar": {
        "backgroundColor": "#88D4FE",
        "textColor": "#000000"
      },
      "storeSelector": {
        "backgroundColor": "#88D4FE",
        "activeChipColor": "#B1EAFF"
      },
      "searchZone": {
        "backgroundColor": "#B1EAFF",
        "waveColor": "#88D4FE",
        "searchHints": ["fresh vegetables", "Amul butter", "cold drinks", "snacks", "dishwash liquid", "Safai Abhiyaan products"],
        "promoBoxImageUrl": null
      },
      "bannerAnimation": {
        "lottieUrl": null,
        "backgroundGradient": ["#B1EAFF", "#A8E6FF"],
        "containerColor": "#D8F4FF"
      },
      "feeStrip": {
        "imageUrl": null,
        "visible": true
      },
      "seasonalMosaic": {
        "containerColor": "#D8F4FF",
        "heroTile": {
          "title": "Summer\nCool Deals",
          "gradient": ["#3F99FE", "#55C5FD"],
          "badgeText": "BUY 2\nGET 1",
          "badgeGradient": ["#FF4CB7", "#D91B83"]
        },
        "miniTiles": [
          {
            "title": "Frozen\nFizz",
            "gradient": ["#3F99FE", "#55C5FD"],
            "imageUrl": null
          },
          {
            "title": "Scoop\nMagic",
            "gradient": ["#4F97FF", "#397BF1"],
            "imageUrl": null
          },
          {
            "title": "Crunch\nBreak",
            "gradient": ["#43A5FF", "#2E83F3"],
            "imageUrl": null
          },
          {
            "title": "Dairy\nDaily",
            "gradient": ["#5AA8FF", "#4283F3"],
            "imageUrl": null
          }
        ]
      },
      "bankOffers": {
        "visible": true,
        "bannerImageUrls": []
      }
    },
    "meta": {
      "seasonLabel": "Summer Sip & Scoop",
      "statusBarBrightness": "light"
    }
  }
  $theme$::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM app_themes
  WHERE name = 'Summer 2026'
);
