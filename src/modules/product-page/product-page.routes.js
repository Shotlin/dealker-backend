import { getLayout, saveLayout, getCondition, PRODUCT_BLOCKS } from './product-page.service.js'
import { success } from '../../utils/apiResponse.js'
import * as units from '../listing-units/units.service.js'

const UUID = /^[0-9a-f-]{36}$/i

/** Public — prefix /api/v1/product-page */
export async function publicProductPageRoutes(fastify) {
  fastify.get('/layout', async () => success({ blocks: await getLayout() }, 'Product page layout'))
  // Devices of a used / refurbished / open-box product (paged, with their state) and one device's full QC report.
  fastify.get('/units/:id', async (request, reply) => {
    const id = String(request.params.id)
    if (!UUID.test(id)) return reply.code(200).send(success({ total: 0, available_count: 0, items: [] }, 'No devices'))
    return reply.code(200).send(success(await units.listUnits(id, { offset: request.query?.offset, limit: request.query?.limit }), 'Devices'))
  })
  // The first N available device numbers — what a buyer gets by default for quantity N.
  fastify.get('/units/:id/first/:n', async (request, reply) => {
    const id = String(request.params.id)
    if (!UUID.test(id)) return reply.code(200).send(success({ unit_nos: [] }, 'No devices'))
    return reply.code(200).send(success({ unit_nos: await units.firstAvailable(id, request.params.n) }, 'Devices'))
  })
  fastify.get('/units/:id/:unitNo', async (request, reply) => {
    const id = String(request.params.id)
    if (!UUID.test(id)) return reply.code(404).send({ success: false, message: 'Not found' })
    try { return reply.code(200).send(success(await units.unitReport(id, request.params.unitNo), 'Device report')) } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
      throw e
    }
  })
  fastify.get('/condition/:id', async (request, reply) => {
    const id = String(request.params.id)
    if (!UUID.test(id)) return reply.code(200).send(success(null, 'No condition data'))
    const data = await getCondition(id)
    return reply.code(200).send(success(data, data ? 'Condition' : 'No condition data'))
  })
}

/** Admin — prefix /api/v1/admin/product-page */
export async function adminProductPageRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })
  fastify.get('/layout', async () => success({ blocks: await getLayout(), catalog: PRODUCT_BLOCKS }, 'Product page layout'))
  fastify.put('/layout', async (request) => {
    const blocks = await saveLayout(request.body?.blocks)
    return success({ blocks, catalog: PRODUCT_BLOCKS }, 'Layout saved')
  })
}
