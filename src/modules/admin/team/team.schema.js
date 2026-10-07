const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const idParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
}

/* ── Roles ── */

export const createRoleSchema = {
    body: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            description: { type: 'string', maxLength: 500 },
            permissions: {
                type: 'array',
                items: { type: 'string' },
                default: [],
            },
        },
    },
}

export const updateRoleSchema = {
    params: idParams,
    body: {
        type: 'object',
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            description: { type: 'string', maxLength: 500 },
            permissions: {
                type: 'array',
                items: { type: 'string' },
            },
        },
    },
}

export const deleteRoleSchema = {
    params: idParams,
}

/* ── Team Members ── */

export const inviteMemberSchema = {
    body: {
        type: 'object',
        required: ['name', 'email', 'role_id', 'password'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', maxLength: 20 },
            role_id: { type: 'string', pattern: uuidPattern },
            password: { type: 'string', minLength: 8, maxLength: 128 },
        },
    },
}

export const updateMemberSchema = {
    params: idParams,
    body: {
        type: 'object',
        properties: {
            role_id: { type: 'string', pattern: uuidPattern },
            is_active: { type: 'boolean' },
        },
    },
}

export const removeMemberSchema = {
    params: idParams,
}
