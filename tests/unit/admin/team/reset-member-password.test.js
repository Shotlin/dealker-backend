import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Coverage for TeamService.resetMemberPassword — the "Change/Reset
 * Password" action added to the Team & Roles dashboard page. Mirrors the
 * shop-staff resetPassword contract (fresh temp password, never a
 * caller-supplied value, returned in plaintext exactly once) but reuses
 * the simpler single-statement UPDATE style already used by the rest of
 * `team.repository.js` (no separate audit-in-tx — `logAdminActivity` is
 * fire-and-forget like every other TeamService mutation).
 */

const findMemberById = vi.fn()
const resetPassword = vi.fn()

vi.mock('../../../../src/modules/admin/team/team.repository.js', () => ({
  TeamRepository: vi.fn().mockImplementation(() => ({
    findMemberById,
    resetPassword,
  })),
}))

const logAdminActivity = vi.fn()
vi.mock('../../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: (...args) => logAdminActivity(...args),
}))

const { TeamService } = await import(
  '../../../../src/modules/admin/team/team.service.js'
)

const MEMBER_ID = '11111111-1111-1111-1111-111111111111'
const ADMIN_ID = '22222222-2222-2222-2222-222222222222'
const IP = '127.0.0.1'

beforeEach(() => {
  findMemberById.mockReset()
  resetPassword.mockReset()
  logAdminActivity.mockReset()
})

describe('TeamService.resetMemberPassword', () => {
  it('returns null without touching the repo write path when the member does not exist', async () => {
    findMemberById.mockResolvedValueOnce(null)

    const svc = new TeamService()
    const result = await svc.resetMemberPassword(MEMBER_ID, ADMIN_ID, IP)

    expect(result).toBeNull()
    expect(resetPassword).not.toHaveBeenCalled()
    expect(logAdminActivity).not.toHaveBeenCalled()
  })

  it('returns null when the repo update matches zero rows', async () => {
    findMemberById.mockResolvedValueOnce({ id: MEMBER_ID })
    resetPassword.mockResolvedValueOnce(false)

    const svc = new TeamService()
    const result = await svc.resetMemberPassword(MEMBER_ID, ADMIN_ID, IP)

    expect(result).toBeNull()
    expect(logAdminActivity).not.toHaveBeenCalled()
  })

  it('generates a fresh 12-char temp password, hashes it, persists the hash, and returns the plaintext once', async () => {
    findMemberById.mockResolvedValueOnce({ id: MEMBER_ID })
    resetPassword.mockResolvedValueOnce(true)

    const svc = new TeamService()
    const result = await svc.resetMemberPassword(MEMBER_ID, ADMIN_ID, IP)

    expect(result).not.toBeNull()
    expect(result.temp_password).toHaveLength(12)
    // Mixed case + digit + symbol guaranteed by the generator.
    expect(result.temp_password).toMatch(/[a-z]/)
    expect(result.temp_password).toMatch(/[A-Z]/)
    expect(result.temp_password).toMatch(/[0-9]/)

    expect(resetPassword).toHaveBeenCalledTimes(1)
    const [calledId, passwordHash] = resetPassword.mock.calls[0]
    expect(calledId).toBe(MEMBER_ID)
    // Never persist (or return) the plaintext where the hash belongs.
    expect(passwordHash).not.toBe(result.temp_password)
    expect(passwordHash.startsWith('$2')).toBe(true) // bcrypt hash prefix

    // Audited, and never with the password/hash in the payload.
    expect(logAdminActivity).toHaveBeenCalledWith(
      ADMIN_ID,
      'RESET_MEMBER_PASSWORD',
      'user',
      MEMBER_ID,
      null,
      null,
      IP,
    )
  })

  it('generates a different temp password on every call', async () => {
    findMemberById.mockResolvedValue({ id: MEMBER_ID })
    resetPassword.mockResolvedValue(true)

    const svc = new TeamService()
    const first = await svc.resetMemberPassword(MEMBER_ID, ADMIN_ID, IP)
    const second = await svc.resetMemberPassword(MEMBER_ID, ADMIN_ID, IP)

    expect(first.temp_password).not.toBe(second.temp_password)
  })
})
