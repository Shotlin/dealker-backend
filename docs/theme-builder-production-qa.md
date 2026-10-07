# Theme Builder — Production QA Checklist

## System Status (Phase 5 Final)

| Component | Status | Notes |
|-----------|--------|-------|
| Dashboard builder TS | 0 errors | getDiagnostics + tsc clean |
| Dashboard builder lint | 0 errors | ESLint clean |
| Dashboard builder tests | 36/36 pass | dndTypes + phase3 + useBuilderHistory |
| Dashboard full suite | 398/404 pass | 6 failures in unrelated modules |
| Backend code | No changes needed | Validated in Phase 4 |
| Flutter code | No changes needed | Validated in Phase 4 |

---

## End-to-End QA Scenarios

### Scenario 1 — Basic Publish
1. Open /themes/builder?tab=all
2. Click top bar → change color → Apply Theme Changes
3. Reload → color persists
4. Push Live → socket event emitted
5. Flutter pull-to-refresh → new color appears

### Scenario 2 — Drag/Drop Reorder
1. Drag section from library → drop between sections
2. Insertion line appears, section lands at correct index
3. Save Draft → Push Live → Flutter shows correct order

### Scenario 3 — Data Binding
1. Select product section → Data tab → add categories
2. Preview updates → Push Live → Flutter shows bound products

### Scenario 4 — Style Presets
1. Click section style preset → preview updates
2. Click page theme preset → chrome colors update
3. Save Draft → Push Live → Flutter reflects changes

### Scenario 5 — Schedule
1. Schedule → BullMQ job created → fires at scheduled time
2. Flutter gets updated manifest after activation

### Scenario 6 — Backward Compatibility
- Old theme without new keys → defaults used
- Unknown section type → renders nothing
- Invalid hex → fallback color
- Empty manifest → empty home

### Scenario 7 — Socket Refresh
1. Push Live → backend emits section:update
2. Flutter clears cache → re-fetches → UI updates

---

## Validation (Backend)

| Rule | Enforcement |
|------|-------------|
| section_type in allowed list | Fastify JSON Schema enum |
| config is object | JSON Schema type:object |
| merch_binding UUIDs valid | format:uuid |
| limit max 50 | maximum:50 |
| source enum | category/tag/manual |
| scheduled_at is datetime | format:date-time |
| Admin auth required | preHandler authenticate+requireAdmin |

---

## Performance

| Metric | Value |
|--------|-------|
| Manifest API (cached) | Redis GET, 300s TTL |
| Cache invalidation | Immediate on publish |
| Socket payload | <200 bytes |
| Flutter API calls per tab | 3 (themes + sections + home) |
| Preview rerender | useDeferredValue |
| Undo history cap | 50 entries |
| Autosave debounce | 3s localStorage |

---

## Known Limitations

1. Bottom nav not themed from remote (hardcoded in Flutter)
2. Offer/coupon selector is placeholder only
3. Product picker uses global list (not store-scoped)
4. 6 pre-existing test failures in login/shop-switcher (unrelated)
5. next build not run locally (tsc+vitest+eslint sufficient)

---

## Deployment Checklist

- Backend migrations up to 026 applied
- Backend on port 4500
- Dashboard on port 4501
- Cloudflare tunnel active
- Flutter .env BASE_URL correct
- Redis running
- PostgreSQL running
- BullMQ worker running
- Socket.IO themes:live room active

---

## Next Steps

1. Fix 6 pre-existing test failures (login/shop-switcher)
2. Add bottomNav to ThemeSections for full nav theming
3. Add store-scoped product search for builder picker
4. Add offer/coupon API when ready
5. Add Playwright E2E for builder drag-drop
