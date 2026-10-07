# Theme Builder Runtime Contract

> Canonical data flow: Dashboard → Backend → Flutter

## Overview

The Bakaloo theme builder system persists two parallel data streams:

1. **Theme chrome** (top bar, search, category tabs, store selector colors) — stored in `app_themes.theme_data` JSONB
2. **Section manifest** (ordered list of homepage sections with config + merch binding) — stored in `section_manifests` table

Both are delivered to the Flutter app via public REST endpoints with ETag caching and Socket.IO live-push.

---

## Theme-Level Payload (`theme_data` JSONB)

```jsonc
{
  "sections": {
    "topBar": { "backgroundColor": "#88D4FE", "textColor": "#000000" },
    "storeSelector": { "backgroundColor": "#88D4FE", "activeChipColor": "#B1EAFF" },
    "categoryTabs": { "visible": true, "textColor": "#111827", "indicatorColor": "#111827" },
    "searchZone": { "backgroundColor": "#B1EAFF", "waveColor": "#88D4FE", "searchHints": [...], "promoBoxImageUrl": null },
    "bannerAnimation": { "lottieUrl": null, "backgroundGradient": [...], "containerColor": "#D8F4FF" },
    "feeStrip": { "imageUrl": null, "visible": true },
    "seasonalMosaic": { ... },
    "bankOffers": { "visible": true, "bannerImageUrls": [] }
  },
  "meta": { "seasonLabel": "Summer Sip & Scoop", "statusBarBrightness": "light" }
}
```

### Rules
- All color values are 6-digit hex with `#` prefix
- Missing keys → Flutter uses hardcoded defaults (no crash)
- Unknown keys → ignored by Flutter (forward-compatible)
- `theme_data` is deep-merged on update (backend `mergeThemeData`)

---

## Section-Level Payload

```jsonc
{
  "id": "uuid",
  "type": "animated_banner",
  "order": 0,
  "visible": true,
  "config": { /* free-form JSONB */ },
  "merch_binding": { "source": "category", "category_ids": [], "product_ids": [], "tags": [], "limit": 12 }
}
```

### Supported section_type values
animated_banner, fee_strip, seasonal_mosaic, round_category_icons, category_product_grid, product_carousel, trending_products, promo_carousel, bank_offers, custom_banner, text_header, arched_product_showcase, spacer

---

## API Endpoints

| Method | Path | Consumer | Purpose |
|--------|------|----------|---------|
| GET | `/api/v1/theme/tabs?store_key=zepto` | Flutter | Tab manifest + theme_data |
| GET | `/api/v1/theme/tabs/:tabKey/sections?store_key=zepto` | Flutter | Section manifest |
| GET | `/api/v1/theme/tabs/:key/home?store_key=zepto` | Flutter | Resolved products |
| PUT | `/api/v1/admin/themes/:id` | Dashboard | Update theme_data |
| POST/PUT/PATCH/DELETE | `/api/v1/admin/sections/*` | Dashboard | Section CRUD |

---

## Socket Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `theme:update` | `{ tabKey, storeKey, themeId, timestamp }` | Theme update/activate |
| `section:update` | `{ tab_key, action, timestamp }` | Section CRUD/reorder |

---

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| Old theme without new keys | Flutter uses defaults |
| Unknown section type | Renders nothing |
| Missing merch_binding | Fallback products |
| Invalid hex color | Default color |
| Empty manifest | Empty home |

---

## Design Tokens (Future)

Add as top-level key in `theme_data` JSONB — no migration needed:
```jsonc
{ "sections": {...}, "meta": {...}, "design_tokens": { "bottom_nav": {...}, "global_accent": "#0C831F" } }
```
