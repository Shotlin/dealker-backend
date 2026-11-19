import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/database.js', () => db)
vi.mock('../../../src/config/logger.js', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../src/modules/refund-requests/refund-requests.service.js', () => ({ toCustomerView: () => ({ timeline: [] }) }))
vi.mock('../../../src/modules/refund-requests/return-journey.service.js', () => ({ ReturnJourneyService: class { async journey() { return {} } } }))
vi.mock('../../../src/modules/support/support.service.js', () => ({ supportService: {} }))

const { decide } = await import('../../../src/modules/vendor-returns/vendor-returns.service.js')
const request = { id: 'r', order_id: 'o', status: 'PENDING', items: [], order_number: 'O1' }
let client

beforeEach(() => {
  vi.clearAllMocks()
  db.query.mockImplementation(async (sql) => ({ rows: sql.includes('SELECT rr.id') ? [request] : [] }))
  client = { query: vi.fn(async (sql) => {
    if (sql.includes('SELECT status, return_approved_at')) return { rows: [{ status: 'PENDING' }] }
    return { rows: [] }
  }), release: vi.fn() }
  db.getClient.mockResolvedValue(client)
})

describe('vendor rejection', () => {
  it('requires evidence and rolls back before recording a rejection', async () => {
    await expect(decide('v', 'u', 'r', { decision: 'REJECT', reason: 'The packing video shows no damage' }))
      .rejects.toMatchObject({ code: 'REJECTION_EVIDENCE_REQUIRED' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO refund_case_events'))).toBe(false)
  })

  it('opens an investigation without closing the request when evidence is present', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT status, return_approved_at')) return { rows: [{ status: 'PENDING' }] }
      if (sql.includes('SELECT stance, evidence')) return { rows: [{ stance: 'DISPUTE', evidence: [{ kind: 'VIDEO' }] }] }
      return { rows: [] }
    })
    await decide('v', 'u', 'r', { decision: 'REJECT', reason: 'The packing video shows no damage' })
    const statements = client.query.mock.calls.map(([sql]) => sql)
    expect(statements.some((sql) => sql.includes("investigation_status = 'OPEN'"))).toBe(true)
    expect(statements.some((sql) => sql.includes("status = 'REJECTED'"))).toBe(false)
    expect(statements).toContain('COMMIT')
  })
})
