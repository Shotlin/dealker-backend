import { getLayout, saveLayout, getCondition, PRODUCT_BLOCKS } from './product-page.service.js'
import { success } from '../../utils/apiResponse.js'

const UUID = /^[0-9a-f-]{36}$/i

/** Public — prefix /api/v1/product-page */
export async function publicProductPageRoutes(fastify) {
  fastify.get('/layout', async () => success({ blocks: await getLayout() }, 'Product page layout'))
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
