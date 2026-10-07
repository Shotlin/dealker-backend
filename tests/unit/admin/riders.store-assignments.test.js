import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
}))

import { AdminRidersService } from '../../../src/modules/admin/riders/riders.service.js'
import { AdminRidersRepository } from '../../../src/modules/admin/riders/riders.repository.js'
import { buildCandidateQuery } from '../../../src/workers/dispatch-eligibility.js'
import { logAdminActivity } from '../../../src/utils/activityLogger.js'

// AdminRidersService closes over a module-level repository singleton,
// so the tests stub the repository prototype methods.
function stubRepo(methods) {
  const originals = {}
  for (const [name, impl] of Object.entries(methods)) {
    originals[name] = AdminRidersRepository.prototype[name]
    AdminRidersRepository.prototype[name] = impl
  }
  return function restore() {
    for (const [name, original] of Object.entries(originals)) {
      AdminRidersRepository.prototype[name] = original
    }
  }
}

// ─── Admin riders service: store assignments ───

describe('AdminRidersService store assignments', () => {
  it('getStoreAssignments returns null when the rider does not exist', async () => {
    const restore = stubRepo({ riderExists: async () => false })
    try {
      const service = new AdminRidersService()
      expect(await service.getStoreAssignments('rider-1')).toBeNull()
    } finally {
      restore()
    }
  })

  it('getStoreAssignments returns rows for an existing rider', async () => {
    const restore = stubRepo({
      riderExists: async () => true,
      getStoreAssignments: async () => [{ shop_id: 'shop-1', shop_name: 'FC Store' }],
    })
    try {
      const service = new AdminRidersService()
      const rows = await service.getStoreAssignments('rider-1')
      expect(rows).toHaveLength(1)
      expect(rows[0].shop_name).toBe('FC Store')
    } finally {
      restore()
    }
  })

  it('replaceStoreAssignments returns null when the rider does not exist', async () => {
    const restore = stubRepo({ riderExists: async () => false })
    try {
      const service = new AdminRidersService()
      expect(await service.replaceStoreAssignments('rider-x', [], 'admin-1')).toBeNull()
    } finally {
      restore()
    }
  })

  it('maps a foreign-key violation to a conflict result', async () => {
    const restore = stubRepo({
      riderExists: async () => true,
      replaceStoreAssignments: async () => {
        const err = new Error('foreign key constraint violation')
        err.code = '23503'
        throw err
      },
    })
    try {
      const service = new AdminRidersService()
      const result = await service.replaceStoreAssignments('rider-1', ['bad-shop'], 'admin-1')
      expect(result).toEqual({ conflict: true })
      expect(logAdminActivity).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('rethrows non-FK errors', async () => {
    const restore = stubRepo({
      riderExists: async () => true,
      replaceStoreAssignments: async () => {
        throw new Error('connection refused')
      },
    })
    try {
      const service = new AdminRidersService()
      await expect(
        service.replaceStoreAssignments('rider-1', ['shop-1'], 'admin-1')
      ).rejects.toThrow('connection refused')
    } finally {
      restore()
    }
  })

  it('returns the change summary and logs admin activity on success', async () => {
    const restore = stubRepo({
      riderExists: async () => true,
      replaceStoreAssignments: async (_riderId, shopIds) => ({
        activated: shopIds.length,
        deactivated: 0,
      }),
    })
    try {
      const service = new AdminRidersService()
      const result = await service.replaceStoreAssignments(
        'rider-1',
        ['shop-1', 'shop-2'],
        'admin-1'
      )
      expect(result).toEqual({ activated: 2, deactivated: 0 })
      expect(logAdminActivity).toHaveBeenCalledWith(
        'admin-1',
        'UPDATE_RIDER_STORE_ASSIGNMENTS',
        'rider',
        'rider-1',
        null,
        { shopIds: ['shop-1', 'shop-2'], activated: 2, deactivated: 0 },
        undefined
      )
    } finally {
      restore()
    }
  })
})

// ─── Dispatch candidate query builder ───

describe('buildCandidateQuery', () => {
  it('builds the unscoped query without params when scoping is off', () => {
    const { sql, params } = buildCandidateQuery({ storeScoping: false, shopId: 'shop-1' })
    expect(params).toEqual([])
    expect(sql).toContain('rp.is_approved = true')
    expect(sql).toContain('rp.is_online = true')
    expect(sql).toContain('u.is_active = true')
    expect(sql).toContain("da.status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')")
    expect(sql).toContain('location_updated_at')
    expect(sql).not.toContain('rider_store_assignments')
  })

  it('adds the active-assignment filter for the order shop when scoping is on', () => {
    const { sql, params } = buildCandidateQuery({ storeScoping: true, shopId: 'shop-abc' })
    expect(params).toEqual(['shop-abc'])
    expect(sql).toContain('rider_store_assignments rsa')
    expect(sql).toContain('rsa.shop_id = $1')
    expect(sql).toContain('rsa.is_active = true')
  })

  it('throws when scoping is requested without a shop id', () => {
    expect(() => buildCandidateQuery({ storeScoping: true, shopId: null })).toThrow(
      'storeScoping requires the order shop id'
    )
  })
})
