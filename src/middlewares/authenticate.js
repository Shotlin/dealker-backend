/**
 * Standalone authenticate preHandler
 * Verifies JWT from Authorization header
 * Use this when you need auth outside the fastify.authenticate decorator
 */
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.code(401).send({
      success: false,
      message: 'Unauthorized — invalid or expired token',
      code: 'UNAUTHORIZED',
    })
  }
}
