import { query, getClient } from "../../../config/database.js";

export class AdminBannersRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT id, title, subtitle, image_url,
              CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
              COALESCE(cta_text, 'none') AS link_type,
              cta_link AS link_value,
              display_order AS sort_order,
              is_active, start_date, end_date, trigger_type, shop_id, created_at, updated_at
       FROM banners ORDER BY display_order ASC, created_at DESC`,
    );
    return rows;
  }

  async findById(id) {
    const {
      rows: [b],
    } = await query(
      `SELECT id, title, subtitle, image_url,
              CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
              COALESCE(cta_text, 'none') AS link_type,
              cta_link AS link_value,
              display_order AS sort_order,
              is_active, start_date, end_date, trigger_type, shop_id, created_at, updated_at
       FROM banners WHERE id = $1`,
      [id],
    );
    return b || null;
  }

  async create({
    title,
    subtitle,
    imageUrl,
    ctaText,
    ctaLink,
    bannerType,
    isActive,
    startDate,
    endDate,
    triggerType,
    shopId,
  }) {
    // Get the highest display_order
    const {
      rows: [{ max: maxOrder }],
    } = await query(
      "SELECT COALESCE(MAX(display_order), 0) AS max FROM banners",
    );
    const {
      rows: [b],
    } = await query(
      `INSERT INTO banners (title, subtitle, image_url, cta_text, cta_link, banner_type, is_active, start_date, end_date, display_order, trigger_type, shop_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, title, subtitle, image_url,
                CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
                COALESCE(cta_text, 'none') AS link_type,
                cta_link AS link_value,
                display_order AS sort_order,
                is_active, start_date, end_date, trigger_type, shop_id, created_at, updated_at`,
      [
        title,
        subtitle || null,
        imageUrl,
        ctaText || null,
        ctaLink || null,
        bannerType || "hero",
        isActive !== false,
        startDate || null,
        endDate || null,
        (maxOrder || 0) + 1,
        triggerType || "ALWAYS",
        shopId || null,
      ],
    );
    return b;
  }

  async update(id, data) {
    const sets = [];
    const params = [];
    let idx = 1;
    const fields = [
      "title",
      "subtitle",
      "image_url",
      "cta_text",
      "cta_link",
      "banner_type",
      "is_active",
      "start_date",
      "end_date",
      "trigger_type",
      "shop_id",
    ];
    const bodyMap = {
      title: "title",
      subtitle: "subtitle",
      image_url: "imageUrl",
      cta_text: "ctaText",
      cta_link: "ctaLink",
      banner_type: "bannerType",
      is_active: "isActive",
      start_date: "startDate",
      end_date: "endDate",
      trigger_type: "triggerType",
      shop_id: "shopId",
    };

    for (const col of fields) {
      const key = bodyMap[col];
      if (data[key] !== undefined) {
        sets.push(`${col} = $${idx++}`);
        params.push(data[key]);
      }
    }
    if (sets.length === 0) return this.findById(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);
    const {
      rows: [b],
    } = await query(
      `UPDATE banners SET ${sets.join(", ")} WHERE id = $${idx}
       RETURNING id, title, subtitle, image_url,
                CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
                COALESCE(cta_text, 'none') AS link_type,
                cta_link AS link_value,
                display_order AS sort_order,
                is_active, start_date, end_date, trigger_type, shop_id, created_at, updated_at`,
      params,
    );
    return b;
  }

  async remove(id) {
    const { rowCount } = await query("DELETE FROM banners WHERE id = $1", [id]);
    return rowCount > 0;
  }

  async reorder(orderedIds) {
    const client = await getClient();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE banners SET display_order = $1, updated_at = NOW() WHERE id = $2",
          [i + 1, orderedIds[i]],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async findActive() {
    const { rows } = await query(
      `SELECT id, title, subtitle, image_url,
              CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
              COALESCE(cta_text, 'none') AS link_type,
              cta_link AS link_value
       FROM banners
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date IS NULL OR end_date >= NOW())
       ORDER BY display_order ASC`,
    );
    return rows;
  }

  /**
   * Same as findActive() but also applies each banner's trigger_type:
   * 'ALWAYS' banners always qualify; 'STORE_CLOSED' banners only qualify
   * when the store is currently closed.
   *
   * `type` given: scopes strictly to that banner_type (used by the
   * Category-landing page for 'category'/'category_footer').
   * `type` omitted: the general storefront feed — excludes 'category' and
   * 'category_footer', which are dedicated to that page only and were never
   * part of the mixed home carousel.
   */
  async findActiveForStoreStatus(isOpen, type, shopId) {
    const typeFilter = type
      ? "AND banner_type = $2"
      : "AND banner_type NOT IN ('category', 'category_footer')";
    const shopParam = type ? "$3" : "$2";
    const params = type ? [isOpen, type, shopId] : [isOpen, shopId];
    const { rows } = await query(
      `SELECT id, title, subtitle, image_url,
              CASE WHEN banner_type = 'hero' THEN 'carousel' ELSE COALESCE(banner_type, 'carousel') END AS banner_type,
              COALESCE(cta_text, 'none') AS link_type,
              cta_link AS link_value,
              trigger_type
       FROM banners
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date IS NULL OR end_date >= NOW())
         AND (trigger_type = 'ALWAYS' OR (trigger_type = 'STORE_CLOSED' AND $1 = false))
         AND (shop_id IS NULL OR shop_id = ${shopParam})
         ${typeFilter}
       ORDER BY display_order ASC`,
      params,
    );
    return rows;
  }
}
