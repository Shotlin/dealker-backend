import fp from 'fastify-plugin'
import helmet from '@fastify/helmet'

async function helmetPlugin(fastify) {
  await fastify.register(helmet, {
    // Disable CSP since this is a pure API server
    contentSecurityPolicy: false,
  })
}

export default fp(helmetPlugin, { name: 'helmet' })
