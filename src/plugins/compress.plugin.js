import fp from 'fastify-plugin'
import compress from '@fastify/compress'

async function compressPlugin(fastify) {
  await fastify.register(compress, {
    global: true,
    threshold: 1024,  // Only compress responses > 1KB
  })
}

export default fp(compressPlugin, { name: 'compress' })
