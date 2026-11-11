import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'

/**
 * Shared device catalogue (brands -> series -> models -> storage) — one source for Sell, Repair, Exchange,
 * vendor Add Product / bulk add / demand posts and auctions. Data lives in device_brands + sell_device_models
 * (imported by src/database/seeds/device-catalogue.js; editable by admins without code changes).
 */
const CATEGORIES = ['Smartphone', 'Tablet', 'Laptop']
const asModel = (r) => ({
  id: r.id, name: r.name, brand: r.brand, brandLogoUrl: r.brand_logo_url, series: r.series, category: r.category,
  imageUrl: r.image_url, storages: r.variants, colors: r.colors, saleEnabled: r.sale_enabled, repairEnabled: r.repair_enabled,
  hasCataloguePrice: r.base_price != null,
})
const moduleClause = (m) => (m === 'sale' ? 'AND m.sale_enabled' : m === 'repair' ? 'AND m.repair_enabled' : '')

/** Authenticated read API — prefix /api/v1/devices */
export async function devicesRoutes(fastify) {
  const pre = [fastify.authenticate]

  // GET /brands?module=sale|repair|all&category=Smartphone
  fastify.get('/brands', { preHandler: pre }, async (req, reply) => {
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : 'Smartphone'
    const { rows } = await query(
      `SELECT b.id, b.name, b.slug, b.logo_url, b.popular, b.sort_order, COUNT(m.id)::int AS models
         FROM device_brands b JOIN sell_device_models m ON lower(m.brand) = lower(b.name) AND m.is_active AND m.category = $1 ${moduleClause(req.query.module)}
        WHERE b.is_active GROUP BY b.id ORDER BY b.popular DESC, b.sort_order, b.name`, [category])
    return reply.send(success(rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, logoUrl: r.logo_url, popular: r.popular, models: r.models })), 'Brands fetched'))
  })

  // GET /models?brand=Samsung&q=s24&module=sale&category=Smartphone&limit=300
  fastify.get('/models', { preHandler: pre }, async (req, reply) => {
    const { brand, q, module, category } = req.query
    const cat = CATEGORIES.includes(category) ? category : 'Smartphone'
    const limit = Math.min(Math.max(Number(req.query.limit) || 400, 1), 800)
    const text = (v) => String(v ?? '').trim().slice(0, 60)
    if (!text(brand) && !text(q)) return reply.code(400).send(error('Choose a brand or type a search', 'VALIDATION'))
    const { rows } = await query(
      `SELECT m.* FROM sell_device_models m LEFT JOIN device_brands b ON lower(b.name) = lower(m.brand)
        WHERE m.is_active AND m.category = $1 ${moduleClause(module)}
          AND ($2::text IS NULL OR lower(m.brand) = lower($2))
          AND ($3::text IS NULL OR m.name ILIKE $3 OR (m.brand || ' ' || m.name) ILIKE $3 OR m.series ILIKE $3)
        ORDER BY COALESCE(b.sort_order, 9999), m.display_order, m.name LIMIT $4`,
      [cat, text(brand) || null, text(q) ? `%${text(q)}%` : null, limit])
    return reply.send(success(rows.map(asModel), 'Models fetched'))
  })

  fastify.get('/models/:id', { preHandler: pre, schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } } }, async (req, reply) => {
    const { rows } = await query('SELECT * FROM sell_device_models WHERE id = $1 AND is_active', [req.params.id])
    if (!rows[0]) return reply.code(404).send(error('Model not found', 'NOT_FOUND'))
    return reply.send(success(asModel(rows[0]), 'Model fetched'))
  })
}

/** Admin: brands (logo, order, popular, on/off) — prefix /api/v1/admin/devices */
export async function devicesAdminRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  fastify.get('/brands', { preHandler: pre }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT b.*, (SELECT COUNT(*)::int FROM sell_device_models m WHERE lower(m.brand) = lower(b.name)) AS models FROM device_brands b ORDER BY b.sort_order, b.name`)
    return reply.send(success(rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, logoUrl: r.logo_url, popular: r.popular, sortOrder: r.sort_order, isActive: r.is_active, models: r.models })), 'Brands fetched'))
  })
  fastify.patch('/brands/:id', {
    preHandler: pre,
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { logoUrl: { type: ['string', 'null'], maxLength: 500 }, popular: { type: 'boolean' }, isActive: { type: 'boolean' }, sortOrder: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  }, async (req, reply) => {
    const b = req.body || {}
    const { rows } = await query(
      `UPDATE device_brands SET logo_url = CASE WHEN $2::boolean THEN $3 ELSE logo_url END, popular = COALESCE($4, popular), is_active = COALESCE($5, is_active),
              sort_order = COALESCE($6, sort_order), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, 'logoUrl' in b, b.logoUrl ?? null, b.popular ?? null, b.isActive ?? null, b.sortOrder ?? null])
    if (!rows[0]) return reply.code(404).send(error('Brand not found', 'NOT_FOUND'))
    if ('logoUrl' in b) await query('UPDATE sell_device_models SET brand_logo_url = $2 WHERE lower(brand) = lower($1)', [rows[0].name, b.logoUrl ?? null])
    return reply.send(success({ id: rows[0].id, name: rows[0].name, logoUrl: rows[0].logo_url, popular: rows[0].popular, isActive: rows[0].is_active, sortOrder: rows[0].sort_order }, 'Brand updated'))
  })
}
