// Coverage for the new CustomerSegmentsService (Phase 1 of the
// customer-segment marketing system): CRUD + membership add/remove.
// Uses constructor injection (repo passed directly) so no database
// mocking is needed.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))
vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn() }))

import { CustomerSegmentsService } from '../../../src/modules/admin/customer-segments/customer-segments.service.js'

const SEGMENT_ID = 'seg-1'
const ACTOR = { userId: 'admin-1', platformRole: 'ADMIN', ip: '127.0.0.1', userAgent: 'test' }

function makeRepoMock(overrides = {}) {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
    findMembers: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    addMembers: vi.fn().mockResolvedValue(0),
    removeMember: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe('CustomerSegmentsService.create (positive/negative)', () => {
  it('creates a segment with a trimmed name', async () => {
    const repo = makeRepoMock({
      create: vi.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'VIP Grocery Customers', member_count: 0 }),
    })
    const service = new CustomerSegmentsService(repo)

    const result = await service.create({ name: '  VIP Grocery Customers  ', description: 'Top spenders' }, ACTOR)

    expect(result.success).toBe(true)
    expect(repo.create).toHaveBeenCalledWith({
      name: 'VIP Grocery Customers',
      description: 'Top spenders',
      createdBy: ACTOR.userId,
    })
  })

  it('rejects an empty/whitespace-only name (negative)', async () => {
    const repo = makeRepoMock()
    const service = new CustomerSegmentsService(repo)

    const result = await service.create({ name: '   ' }, ACTOR)

    expect(result.success).toBe(false)
    expect(repo.create).not.toHaveBeenCalled()
  })
})

describe('CustomerSegmentsService.update / delete (positive/negative)', () => {
  it('returns not-found when updating a segment that does not exist (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CustomerSegmentsService(repo)

    const result = await service.update('missing', { name: 'x' }, ACTOR)

    expect(result.success).toBe(false)
    expect(result.message).toBe('Segment not found')
  })

  it('updates an existing segment (positive)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'Old', member_count: 0 }),
      update: vi.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'New', member_count: 0 }),
    })
    const service = new CustomerSegmentsService(repo)

    const result = await service.update(SEGMENT_ID, { name: 'New' }, ACTOR)

    expect(result.success).toBe(true)
    expect(result.segment.name).toBe('New')
  })

  it('deletes an existing segment (positive) and cascades via FK — no separate member cleanup needed', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'VIP', member_count: 3 }),
    })
    const service = new CustomerSegmentsService(repo)

    const result = await service.delete(SEGMENT_ID, ACTOR)

    expect(result.success).toBe(true)
    expect(repo.delete).toHaveBeenCalledWith(SEGMENT_ID)
  })
})

describe('CustomerSegmentsService membership add/remove (positive/negative)', () => {
  it('adds members to an existing segment (positive)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'VIP' }),
      addMembers: vi.fn().mockResolvedValue(2),
    })
    const service = new CustomerSegmentsService(repo)

    const result = await service.addMembers(SEGMENT_ID, ['u1', 'u2'], ACTOR)

    expect(result.success).toBe(true)
    expect(result.addedCount).toBe(2)
  })

  it('rejects adding members to a segment that does not exist (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CustomerSegmentsService(repo)

    const result = await service.addMembers(SEGMENT_ID, ['u1'], ACTOR)

    expect(result.success).toBe(false)
    expect(repo.addMembers).not.toHaveBeenCalled()
  })

  it('rejects an empty userIds array (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue({ id: SEGMENT_ID }) })
    const service = new CustomerSegmentsService(repo)

    const result = await service.addMembers(SEGMENT_ID, [], ACTOR)

    expect(result.success).toBe(false)
  })

  it('removes a member from a segment (positive)', async () => {
    const repo = makeRepoMock({ removeMember: vi.fn().mockResolvedValue(true) })
    const service = new CustomerSegmentsService(repo)

    const result = await service.removeMember(SEGMENT_ID, 'u1', ACTOR)

    expect(result.success).toBe(true)
  })

  it('returns not-found when removing a member who is not in the segment (negative)', async () => {
    const repo = makeRepoMock({ removeMember: vi.fn().mockResolvedValue(false) })
    const service = new CustomerSegmentsService(repo)

    const result = await service.removeMember(SEGMENT_ID, 'ghost', ACTOR)

    expect(result.success).toBe(false)
  })
})
