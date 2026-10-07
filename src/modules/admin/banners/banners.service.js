import { AdminBannersRepository } from "./banners.repository.js";
import { logAdminActivity } from "../../../utils/activityLogger.js";
import { normalizeCloudinaryDeliveryUrl } from "../../../config/cloudinary.js";

const repo = new AdminBannersRepository();

export class AdminBannersService {
  constructor() {}

  /**
   * Store open/closed filtering was a grocery quick-commerce concept; the
   * marketplace storefront is always-on. Banners return regardless of a
   * store-status singleton now.
   */

  async list() {
    return this._normalizeBanners(await repo.findAll());
  }

  async getById(id) {
    return this._normalizeBanner(await repo.findById(id));
  }

  async create(data, adminId, ip) {
    const mapped = {
      title: data.title,
      subtitle: data.subtitle,
      imageUrl: data.imageUrl,
      ctaText: data.linkType !== "none" ? data.linkType : null,
      ctaLink: data.linkType !== "none" ? data.linkValue : null,
      bannerType:
        data.bannerType === "carousel" ? "hero" : data.bannerType || "hero",
      isActive: data.isActive,
      startDate: data.startDate,
      endDate: data.endDate,
      triggerType: data.triggerType,
      shopId: data.shopId,
    };
    const banner = await repo.create(mapped);
    logAdminActivity(
      adminId,
      "CREATE_BANNER",
      "banner",
      banner.id,
      null,
      null,
      ip,
    );
    return this._normalizeBanner(banner);
  }

  async update(id, data, adminId, ip) {
    const mapped = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
      ...(data.linkType !== undefined && {
        ctaText: data.linkType !== "none" ? data.linkType : null,
      }),
      ...(data.linkValue !== undefined && { ctaLink: data.linkValue }),
      ...(data.bannerType !== undefined && {
        bannerType: data.bannerType === "carousel" ? "hero" : data.bannerType,
      }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
      ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
      ...(data.shopId !== undefined && { shopId: data.shopId }),
    };
    const banner = await repo.update(id, mapped);
    logAdminActivity(adminId, "UPDATE_BANNER", "banner", id, null, null, ip);
    return this._normalizeBanner(banner);
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id);
    if (ok)
      logAdminActivity(adminId, "DELETE_BANNER", "banner", id, null, null, ip);
    return ok;
  }

  async reorder(orderedIds, adminId, ip) {
    await repo.reorder(orderedIds);
    logAdminActivity(
      adminId,
      "REORDER_BANNERS",
      "banner",
      null,
      null,
      { count: orderedIds.length },
      ip,
    );
    return true;
  }

  async getActive() {
    return this._normalizeBanners(await repo.findActive());
  }

  /**
   * Public-facing banner list filtered by each banner's trigger_type against
   * the current store-open/closed state — 'ALWAYS' banners always included,
   * 'STORE_CLOSED' banners only included while the store is closed.
   *
   * `type` optionally scopes to a single banner_type (e.g. 'category' for the
   * mobile Category-landing page's top carousel, 'category_footer' for its
   * bottom combo strip). Omitted, the general storefront feed is returned —
   * which excludes those two page-specific types (see repository).
   */
  async getActiveForStoreStatus(type, shopId) {
    // Marketplace storefront is always-on: pass isOpen=true so time-gated
    // trigger types behave exactly as when the (grocery) store was open.
    return this._normalizeBanners(
      await repo.findActiveForStoreStatus(true, type, shopId),
    );
  }

  _normalizeBanners(banners = []) {
    return banners.map((banner) => this._normalizeBanner(banner));
  }

  _normalizeBanner(banner) {
    if (!banner) return banner;

    return {
      ...banner,
      image_url: normalizeCloudinaryDeliveryUrl(banner.image_url, "default"),
    };
  }
}
