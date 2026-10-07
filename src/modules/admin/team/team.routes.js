import { TeamController } from './team.controller.js'
import {
    createRoleSchema,
    updateRoleSchema,
    deleteRoleSchema,
    inviteMemberSchema,
    updateMemberSchema,
    removeMemberSchema,
} from './team.schema.js'

const ctrl = new TeamController()

/**
 * Roles routes — prefix: /roles
 * GET  /          — team.view (list all roles)
 * POST /          — team.manage (create role)
 * PATCH /:id      — team.manage (update role)
 * DELETE /:id     — team.manage (delete role)
 */
export async function roleRoutes(fastify) {
    const auth = [fastify.authenticate, fastify.requireAdmin]
    const authManage = [...auth, fastify.requirePermission('team.manage')]

    fastify.get('/', { preHandler: auth }, ctrl.listRoles.bind(ctrl))

    fastify.post('/', {
        schema: createRoleSchema,
        preHandler: authManage,
    }, ctrl.createRole.bind(ctrl))

    fastify.patch('/:id', {
        schema: updateRoleSchema,
        preHandler: authManage,
    }, ctrl.updateRole.bind(ctrl))

    fastify.delete('/:id', {
        schema: deleteRoleSchema,
        preHandler: authManage,
    }, ctrl.deleteRole.bind(ctrl))
}

/**
 * Team routes — prefix: /team
 * GET  /                 — team.view (list members)
 * POST /invite           — team.manage (invite)
 * PATCH /:id             — team.manage (update)
 * DELETE /:id            — team.manage (remove)
 * POST /:id/reset-password — team.manage (reset to a fresh temp password)
 */
export async function teamRoutes(fastify) {
    const auth = [fastify.authenticate, fastify.requireAdmin]
    const authManage = [...auth, fastify.requirePermission('team.manage')]

    fastify.get('/', { preHandler: auth }, ctrl.listMembers.bind(ctrl))

    fastify.post('/invite', {
        schema: inviteMemberSchema,
        preHandler: authManage,
    }, ctrl.inviteMember.bind(ctrl))

    fastify.patch('/:id', {
        schema: updateMemberSchema,
        preHandler: authManage,
    }, ctrl.updateMember.bind(ctrl))

    fastify.delete('/:id', {
        schema: removeMemberSchema,
        preHandler: authManage,
    }, ctrl.removeMember.bind(ctrl))

    fastify.post('/:id/reset-password', {
        preHandler: authManage,
    }, ctrl.resetMemberPassword.bind(ctrl))
}
