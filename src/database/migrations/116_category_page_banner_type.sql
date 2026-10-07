-- Migration 116: category_footer banner type — a second placement slot for
-- the mobile Category-landing page (banner_type='category' already existed
-- and now feeds that page's top carousel; this adds 'category_footer' for
-- the wide combo/promo strip below the category grid). Both are excluded
-- from the general storefront banner feed by default (see banners.repository
-- findActiveForStoreStatus) — they only show on the dedicated category page.

ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_banner_type_check;
ALTER TABLE banners ADD CONSTRAINT banners_banner_type_check
  CHECK (banner_type IN ('hero', 'offer', 'popup', 'announcement', 'category', 'category_footer'));
