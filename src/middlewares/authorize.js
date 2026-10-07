/**
 * Role-based authorization preHandler factory
 * Must be used AFTER authenticate — request.user must exist
 *
 * @param {string[]} allowedRoles - Array of role names e.g. ['ADMIN', 'RIDER']
 * @returns {Function} Fastify preHandler
 *
 * Usage in routes:
 *   preHandler: [fastify.authenticate, authorize(['ADMIN'])]
 */
export function authorize(allowedRoles) {
  return async function (request, reply) {
    if (!request.user) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — authentication required',
        code: 'UNAUTHORIZED',
      })
    }

    const { role } = request.user

    if (!allowedRoles.includes(role)) {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden — insufficient permissions',
        code: 'FORBIDDEN',
      })
    }
  }
}
