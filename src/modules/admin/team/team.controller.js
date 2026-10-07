import { TeamService } from './team.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new TeamService()

export class TeamController {
    /* ── Roles ── */

    async listRoles(request, reply) {
        const data = await svc.listRoles()
        return success(data, 'Roles fetched')
    }

    async createRole(request, reply) {
        const role = await svc.createRole(request.body, request.user.id, request.ip)
        reply.code(201)
        return success(role, 'Role created')
    }

    async updateRole(request, reply) {
        const role = await svc.updateRole(request.params.id, request.body, request.user.id, request.ip)
        if (!role) return reply.code(404).send(error('Role not found or is a system role', 404))
        return success(role, 'Role updated')
    }

    async deleteRole(request, reply) {
        const ok = await svc.deleteRole(request.params.id, request.user.id, request.ip)
        if (!ok) return reply.code(404).send(error('Role not found or is a system role', 404))
        return success(null, 'Role deleted')
    }

    /* ── Team Members ── */

    async listMembers(request, reply) {
        const data = await svc.listMembers()
        return success(data, 'Team members fetched')
    }

    async inviteMember(request, reply) {
        try {
            const member = await svc.inviteMember(request.body, request.user.id, request.ip)
            reply.code(201)
            return success(member, 'Member invited')
        } catch (err) {
            const code = err.statusCode || 400
            return reply.code(code).send(error(err.message, code))
        }
    }

    async updateMember(request, reply) {
        const member = await svc.updateMember(request.params.id, request.body, request.user.id, request.ip)
        if (!member) return reply.code(404).send(error('Member not found', 404))
        return success(member, 'Member updated')
    }

    async removeMember(request, reply) {
        const ok = await svc.removeMember(request.params.id, request.user.id, request.ip)
        if (!ok) return reply.code(404).send(error('Member not found', 404))
        return success(null, 'Member removed')
    }

    async resetMemberPassword(request, reply) {
        const result = await svc.resetMemberPassword(request.params.id, request.user.id, request.ip)
        if (!result) return reply.code(404).send(error('Member not found', 404))
        return success(result, 'Password reset')
    }
}
