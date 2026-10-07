import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { env } from '../config/env.js'

async function swaggerPlugin(fastify) {
  if (!env.ENABLE_SWAGGER) {
    fastify.log.info('Swagger UI disabled for this environment')
    return
  }

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Meet Commerce API',
        description: 'Meet Commerce Backend — Fastify API',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Health check' },
        { name: 'Auth', description: 'Authentication — OTP, JWT, OAuth' },
        { name: 'Users', description: 'User profile management' },
        { name: 'Categories', description: 'Product categories' },
        { name: 'Products', description: 'Product catalog' },
        { name: 'Cart', description: 'Shopping cart' },
        { name: 'Wishlist', description: 'User wishlist' },
        { name: 'Addresses', description: 'Delivery addresses' },
        { name: 'Orders', description: 'Order management' },
        { name: 'Payments', description: 'Payment processing' },
        { name: 'Wallet', description: 'Digital wallet' },
        { name: 'Coupons', description: 'Discount coupons' },
        { name: 'Delivery', description: 'Rider delivery management' },
        { name: 'Notifications', description: 'Push notifications' },
        { name: 'Reviews', description: 'Product reviews' },
        { name: 'Uploads', description: 'File uploads' },
        { name: 'Admin', description: 'Admin dashboard & management' },
      ],
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  })
}

export default fp(swaggerPlugin, { name: 'swagger' })
