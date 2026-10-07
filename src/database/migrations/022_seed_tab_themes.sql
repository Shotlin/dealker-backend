-- 022_seed_tab_themes.sql
-- Seed tab-specific themes for the dynamic theming system

-- Navratri theme (warm orange/gold tones)
INSERT INTO app_themes (
  name,
  tab_key,
  tab_label,
  tab_icon_url,
  tab_order,
  status,
  is_active,
  ab_variant,
  ab_split_percent,
  version,
  theme_data
)
SELECT
  'Navratri',
  'navratri',
  'Navratri',
  NULL,
  1,
  'active',
  false,
  'A',
  100,
  1,
  $navratri$
  {
    "sections": {
      "topBar": { "backgroundColor": "#FEEBCC", "textColor": "#000000" },
      "storeSelector": { "backgroundColor": "#FEEBCC", "activeChipColor": "#FFD580" },
      "searchZone": {
        "backgroundColor": "#FFF3E0",
        "waveColor": "#FEEBCC",
        "searchHints": ["Puja thali", "Navratri special", "Bel patra", "Diya", "Incense sticks"],
        "promoBoxImageUrl": null
      },
      "bannerAnimation": {
        "lottieUrl": null,
        "backgroundGradient": ["#FFF3E0", "#FEEBCC"],
        "containerColor": "#FFF8ED"
      },
      "feeStrip": { "imageUrl": null, "visible": true },
      "seasonalMosaic": {
        "containerColor": "#FFF8ED",
        "heroTile": {
          "title": "Navratri\nSpecial",
          "gradient": ["#FF8C00", "#FFA500"],
          "badgeText": "PUJA\nESSENTIALS",
          "badgeGradient": ["#E91E63", "#C2185B"]
        },
        "miniTiles": [
          { "title": "Vrat\nSnacks", "gradient": ["#FF8C00", "#FFA500"], "imageUrl": null },
          { "title": "Puja\nItems", "gradient": ["#FF9800", "#FFB74D"], "imageUrl": null },
          { "title": "Idols &\nShringar", "gradient": ["#F57C00", "#FF9800"], "imageUrl": null },
          { "title": "Fresh\nCorner", "gradient": ["#EF6C00", "#F57C00"], "imageUrl": null }
        ]
      },
      "bankOffers": { "visible": true, "bannerImageUrls": [] }
    },
    "meta": { "seasonLabel": "Navratri Shubh Aarambh", "statusBarBrightness": "dark" }
  }
  $navratri$::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM app_themes
  WHERE tab_key = 'navratri'
);

-- Fresh theme (green tones)
INSERT INTO app_themes (
  name,
  tab_key,
  tab_label,
  tab_icon_url,
  tab_order,
  status,
  is_active,
  ab_variant,
  ab_split_percent,
  version,
  theme_data
)
SELECT
  'Fresh',
  'fresh',
  'Fresh',
  NULL,
  2,
  'active',
  false,
  'A',
  100,
  1,
  $fresh$
  {
    "sections": {
      "topBar": { "backgroundColor": "#BEEBFD", "textColor": "#000000" },
      "storeSelector": { "backgroundColor": "#BEEBFD", "activeChipColor": "#E0F7FA" },
      "searchZone": {
        "backgroundColor": "#E0F7FA",
        "waveColor": "#BEEBFD",
        "searchHints": ["Tomato", "Onion", "Potato", "Palak", "Fruits"],
        "promoBoxImageUrl": null
      },
      "bannerAnimation": {
        "lottieUrl": null,
        "backgroundGradient": ["#E0F7FA", "#B2EBF2"],
        "containerColor": "#E8F5E9"
      },
      "feeStrip": { "imageUrl": null, "visible": true },
      "seasonalMosaic": {
        "containerColor": "#E8F5E9",
        "heroTile": {
          "title": "Fresh\nProduce",
          "gradient": ["#4CAF50", "#66BB6A"],
          "badgeText": "BEST\nQUALITY",
          "badgeGradient": ["#2E7D32", "#1B5E20"]
        },
        "miniTiles": [
          { "title": "Veggies", "gradient": ["#43A047", "#66BB6A"], "imageUrl": null },
          { "title": "Fruits", "gradient": ["#388E3C", "#4CAF50"], "imageUrl": null },
          { "title": "New\nLaunches", "gradient": ["#2E7D32", "#43A047"], "imageUrl": null },
          { "title": "Herbs &\nSpices", "gradient": ["#1B5E20", "#2E7D32"], "imageUrl": null }
        ]
      },
      "bankOffers": { "visible": true, "bannerImageUrls": [] }
    },
    "meta": { "seasonLabel": "Fresh Fruits & Vegetables", "statusBarBrightness": "light" }
  }
  $fresh$::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM app_themes
  WHERE tab_key = 'fresh'
);

-- Fashion theme (pink tones)
INSERT INTO app_themes (
  name,
  tab_key,
  tab_label,
  tab_icon_url,
  tab_order,
  status,
  is_active,
  ab_variant,
  ab_split_percent,
  version,
  theme_data
)
SELECT
  'Fashion',
  'fashion',
  'Fashion',
  NULL,
  3,
  'active',
  false,
  'A',
  100,
  1,
  $fashion$
  {
    "sections": {
      "topBar": { "backgroundColor": "#FCE9FA", "textColor": "#000000" },
      "storeSelector": { "backgroundColor": "#FCE9FA", "activeChipColor": "#F8BBD0" },
      "searchZone": {
        "backgroundColor": "#FDE7F9",
        "waveColor": "#FCE9FA",
        "searchHints": ["T-shirt", "Jeans", "Sneakers", "Watch", "Perfume"],
        "promoBoxImageUrl": null
      },
      "bannerAnimation": {
        "lottieUrl": null,
        "backgroundGradient": ["#FDE7F9", "#F8BBD0"],
        "containerColor": "#FFF0F5"
      },
      "feeStrip": { "imageUrl": null, "visible": true },
      "seasonalMosaic": {
        "containerColor": "#FFF0F5",
        "heroTile": {
          "title": "Fashion\nFiesta",
          "gradient": ["#E91E63", "#F06292"],
          "badgeText": "BUY 2\nGET 15%",
          "badgeGradient": ["#AD1457", "#880E4F"]
        },
        "miniTiles": [
          { "title": "Men", "gradient": ["#1565C0", "#42A5F5"], "imageUrl": null },
          { "title": "Women", "gradient": ["#E91E63", "#F06292"], "imageUrl": null },
          { "title": "Inner\nwear", "gradient": ["#7B1FA2", "#AB47BC"], "imageUrl": null },
          { "title": "Foot\nwear", "gradient": ["#00897B", "#26A69A"], "imageUrl": null }
        ]
      },
      "bankOffers": { "visible": true, "bannerImageUrls": [] }
    },
    "meta": { "seasonLabel": "Fashion Pair-Up", "statusBarBrightness": "dark" }
  }
  $fashion$::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM app_themes
  WHERE tab_key = 'fashion'
);

-- Electronics theme (dark mode)
INSERT INTO app_themes (
  name,
  tab_key,
  tab_label,
  tab_icon_url,
  tab_order,
  status,
  is_active,
  ab_variant,
  ab_split_percent,
  version,
  theme_data
)
SELECT
  'Electronics',
  'electronics',
  'Electronics',
  NULL,
  4,
  'active',
  false,
  'A',
  100,
  1,
  $electronics$
  {
    "sections": {
      "topBar": { "backgroundColor": "#1A1A2E", "textColor": "#FFFFFF" },
      "storeSelector": { "backgroundColor": "#1A1A2E", "activeChipColor": "#FF6B35" },
      "searchZone": {
        "backgroundColor": "#16213E",
        "waveColor": "#1A1A2E",
        "searchHints": ["iPhone", "Samsung Galaxy", "Earbuds", "Charger", "Power Bank"],
        "promoBoxImageUrl": null
      },
      "bannerAnimation": {
        "lottieUrl": null,
        "backgroundGradient": ["#1A1A2E", "#0F3460"],
        "containerColor": "#16213E"
      },
      "feeStrip": { "imageUrl": null, "visible": true },
      "seasonalMosaic": {
        "containerColor": "#16213E",
        "heroTile": {
          "title": "Electronics\nFest",
          "gradient": ["#FF6B35", "#FF8C00"],
          "badgeText": "UP TO\n30% OFF",
          "badgeGradient": ["#E53935", "#C62828"]
        },
        "miniTiles": [
          { "title": "Audio &\nGadgets", "gradient": ["#FF6B35", "#FF8C00"], "imageUrl": null },
          { "title": "Appli\nances", "gradient": ["#FF5722", "#FF7043"], "imageUrl": null },
          { "title": "Mobile\nStore", "gradient": ["#E64A19", "#FF5722"], "imageUrl": null },
          { "title": "Charging\nAccs", "gradient": ["#BF360C", "#E64A19"], "imageUrl": null }
        ]
      },
      "bankOffers": { "visible": true, "bannerImageUrls": [] }
    },
    "meta": { "seasonLabel": "Electronics Fest", "statusBarBrightness": "light" }
  }
  $electronics$::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM app_themes
  WHERE tab_key = 'electronics'
);
