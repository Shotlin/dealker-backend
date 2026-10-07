import { PublicThemeController } from './public.controller.js'

const ctrl = new PublicThemeController()

export default async function publicThemeRoutes(fastify) {
  // Best-effort JWT verification, same pattern as products.routes.js: if a
  // token is present and valid it lands on request.user (so the controller
  // can resolve the customer's shop for per-store theming); otherwise the
  // request proceeds anonymously — this stays a genuinely public endpoint.
  const tryAttachUser = async (request) => {
    if (typeof fastify.optionalAuth === 'function') {
      try {
        await fastify.optionalAuth(request)
      } catch {
        /* anonymous fallback */
      }
      return
    }
    try {
      await request.jwtVerify()
    } catch {
      /* anonymous fallback */
    }
  }

  fastify.get('/active', {
    schema: {
      tags: ['Theme'],
      summary: 'Get active theme for the app (public, optionally shop-scoped)',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              anyOf: [
                { type: 'object', additionalProperties: true },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getActiveTheme.bind(ctrl))

  fastify.get('/tabs', {
    schema: {
      tags: ['Theme'],
      summary: 'Get all active tab themes (public, no auth)',
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['marketplace', 'deals', 'brand_store', 'new_arrivals'],
          },
          priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getTabThemes.bind(ctrl))

  fastify.get('/tabs/:key/home', {
    schema: {
      tags: ['Theme'],
      summary: 'Get resolved home merchandising for a tab (public, optionally shop-scoped)',
      params: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['marketplace', 'deals', 'brand_store', 'new_arrivals'],
          },
          priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getTabHomeContent.bind(ctrl))

  fastify.get('/tabs/:tabKey/sections', {
    schema: {
      tags: ['Theme'],
      summary: 'Get section manifest for a tab (public, optionally shop-scoped)',
      params: {
        type: 'object',
        required: ['tabKey'],
        properties: {
          tabKey: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['marketplace', 'deals', 'brand_store', 'new_arrivals'],
          },
          priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getSectionManifest.bind(ctrl))

  fastify.post('/analytics', {
    schema: {
      tags: ['Theme'],
      summary: 'Record theme analytics events (public)',
      body: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                theme_id: { type: 'string' },
                tab_key: { type: 'string' },
                event_type: { type: 'string' },
                user_id: { type: 'string' },
                session_id: { type: 'string' },
                store_key: { type: 'string' },
                section_key: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, ctrl.recordAnalytics.bind(ctrl))
}
