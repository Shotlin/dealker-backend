import fp from 'fastify-plugin'
import multipart from '@fastify/multipart'
import { env } from '../config/env.js'

async function multipartPlugin(fastify) {
  await fastify.register(multipart, {
    limits: {
      fileSize: env.MAX_FILE_SIZE,  // default 5MB
      files: 10,                     // max files per request
    },
    attachFieldsToBody: false,
  })
}

export default fp(multipartPlugin, { name: 'multipart' })
