/**
 * Deals & Merchandising — admin view of a tab's sections with the products the
 * app will really show. Reads through the same resolver the public manifest uses
 * (resolveManifestSection); edits go through the existing /admin/sections APIs.
 */
import { resolveManifestSection } from '../../themes/public.controller.js'
import { getProductsByRules, normalizeRules } from '../../themes/merch-rules.js'
import { SectionsRepository } from '../sections/sections.repository.js'
import { DealEntriesService } from '../../promo-campaigns/deal-entries.service.js'
import { success } from '../../../utils/apiResponse.js'
import { query } from '../../../config/database.js'

const repo = new SectionsRepository()
const entries = new DealEntriesService()
const guard = (fn) => async (request, reply) => {
  try { return await fn(request, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

// Section types that never show a product list.
const STATIC_TYPES = new Set(['fee_strip', 'spacer', 'text_header', 'animated_banner', 'custom_banner', 'promo_carousel', 'bank_offers', 'round_category_icons', 'category_hub', 'shops_nearby', 'live_auction'])

const tabProducts = (config) =>
  (Array.isArray(config?.tabs) ? config.tabs : []).reduce((n, t) => n + (t.products?.length ?? 0), 0)

function summarise(section) {
  const isStatic = STATIC_TYPES.has(section.section_type)
  const count = Array.isArray(section.products) ? section.products.length : tabProducts(section.config)
  const status = isStatic ? 'static' : !section.visible ? 'hidden' : count === 0 ? 'empty' : 'live'
  return { status, product_count: isStatic ? null : count }
}

export default async function adminMerchSectionRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/:tabId', {
    schema: { params: { type: 'object', required: ['tabId'], properties: { tabId: { type: 'string', format: 'uuid' } } } },
  }, async (request) => {
    const rows = await repo.findByTabId(request.params.tabId, null)
    // Names of products the admin hid, so the page can list them with a Restore button.
    const hiddenIds = [...new Set(rows.flatMap((r) => [
      ...(r.merch_binding?.exclude_ids ?? []),
      ...(Array.isArray(r.config?.tabs) ? r.config.tabs.flatMap((t) => t.exclude_ids ?? []) : []),
    ]))]
    const names = hiddenIds.length
      ? Object.fromEntries((await query('SELECT id, name FROM products WHERE id = ANY($1::uuid[])', [hiddenIds])).rows.map((p) => [p.id, p.name]))
      : {}
    const sections = await Promise.all(rows.map(async (row) => {
      // resolveManifestSection reads `type`; the table column is `section_type`.
      const resolved = await resolveManifestSection({ ...row, type: row.section_type }, null, 'retail')
      const { type, ...rest } = resolved
      const section = { ...rest, section_type: row.section_type }
      return { ...section, ...summarise(section) }
    }))
    return success({ sections, hidden_names: names }, 'Merchandising sections')
  })

  // Deals (promo campaigns) and where each is shown. Create/edit them on the Campaigns page.
  fastify.get('/deals', async () => {
    const { rows: deals } = await query(
      `SELECT c.id, c.name, c.type, c.status, c.starts_at, c.ends_at, c.discount, c.listing_count, c.section,
              c.open_to_vendors, c.entry_deadline, c.min_vendor_tier, c.require_approval, c.max_entries_per_vendor,
              (SELECT COUNT(*)::int FROM deal_entries e WHERE e.campaign_id = c.id AND e.status = 'PENDING') AS pending_entries,
              (SELECT COUNT(*)::int FROM deal_entries e WHERE e.campaign_id = c.id AND e.status = 'APPROVED') AS approved_entries
         FROM promo_campaigns c
        WHERE c.status <> 'CANCELLED' AND c.type <> 'COUPON'
        ORDER BY (c.status = 'ACTIVE') DESC, (c.status = 'SCHEDULED') DESC, c.starts_at DESC NULLS LAST, c.created_at DESC
        LIMIT 100`)
    const { rows: usage } = await query(
      `SELECT s.id AS section_id, s.section_type, s.config, s.merch_binding, t.label AS tab_label, t.store_key
         FROM section_manifests s JOIN theme_tabs t ON t.id = s.tab_id
        WHERE s.merch_binding ? 'campaign_id' OR s.config::text LIKE '%campaign_id%'`)
    const usedIn = (id) => usage.flatMap((u) => {
      const tabs = Array.isArray(u.config?.tabs) ? u.config.tabs : []
      const hits = (u.merch_binding?.campaign_id === id ? [null] : []).concat(tabs.filter((tb) => tb.campaign_id === id).map((tb) => tb.label ?? 'Tab'))
      return hits.map((tab) => ({ section_id: u.section_id, section_type: u.section_type, screen: `${u.store_key} / ${u.tab_label}`, tab }))
    })
    return success(deals.map((d) => ({ ...d, used_in: usedIn(d.id) })), 'Deals')
  })

  // Vendor entries for a deal: queue, approve / reject, and the open-to-vendors settings.
  fastify.get('/deals/:id/entries', { schema: { params: idParams } },
    guard(async (req) => success(await entries.listForAdmin(req.params.id, String(req.query?.status || '').toUpperCase()), 'Deal entries')))
  fastify.post('/deals/:id/entries/decide', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['ids', 'decision'],
        properties: {
          ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 500 },
          decision: { enum: ['APPROVED', 'REJECTED'] },
          reason: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, guard(async (req) => success(await entries.decide(req.params.id, req.body.ids, req.body.decision, req.body.reason, req.user.id), 'Entries updated')))
  fastify.patch('/deals/:id/vendor-entry', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        properties: {
          open_to_vendors: { type: 'boolean' },
          entry_deadline: { type: ['string', 'null'] },
          min_vendor_tier: { enum: ['FREE', 'PAID', 'PREMIUM', 'UNLIMITED'] },
          require_approval: { type: 'boolean' },
          max_entries_per_vendor: { type: ['integer', 'null'] },
        },
      },
    },
  }, guard(async (req) => success(await entries.setOpen(req.params.id, req.body), 'Vendor entry settings saved')))

  // Live preview of a rule set while the admin is still editing it (nothing is saved).
  fastify.post('/preview-rules', {
    schema: {
      body: {
        type: 'object',
        required: ['rules'],
        properties: {
          rules: { type: 'object' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
          exclude_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, default: [] },
        },
      },
    },
  }, async (request) => {
    const { rules, limit, exclude_ids: excludeIds } = request.body
    if (!normalizeRules(rules)) return success({ total: 0, products: [] }, 'No rules set')
    return success(await getProductsByRules(rules, limit, excludeIds, null, 'retail'), 'Rules preview')
  })
}
