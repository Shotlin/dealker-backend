import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock database query
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/config/database.js', () => ({
  query: queryMock,
}))

// Mock logger
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  classifyDeviceType,
  createDeviceSession,
  generateDeviceFingerprint,
  isSessionActive,
  listActiveSessions,
  revokeAllOtherSessions,
  revokeAllUserSessions,
  revokeSession,
} from '../../../src/utils/session.js'

describe('Phase 1E Authentication & Session Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Session Utils', () => {
    it('generates consistent SHA-256 device fingerprint', () => {
      const fp1 = generateDeviceFingerprint('192.168.1.1', 'Mozilla/5.0')
      const fp2 = generateDeviceFingerprint('192.168.1.1', 'Mozilla/5.0')

      expect(fp1).toHaveLength(64)
      expect(fp1).toBe(fp2)
    })

    it('classifies device type from User-Agent string correctly', () => {
      expect(classifyDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0)')).toBe('MOBILE_APP')
      expect(classifyDeviceType('Mozilla/5.0 (iPad; CPU OS 14_0)')).toBe('TABLET')
      expect(classifyDeviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/90.0')).toBe('WEB_DASHBOARD')
      expect(classifyDeviceType(null)).toBe('UNKNOWN')
    })

    it('creates device session with fingerprint and expiry', async () => {
      const mockSession = { id: 'sess-123', device_fingerprint: 'fp-123', expires_at: new Date() }
      queryMock.mockResolvedValueOnce({ rows: [mockSession] })

      const req = { ip: '10.0.0.1', headers: { 'user-agent': 'Chrome' } }
      const res = await createDeviceSession({ userId: 'u-1', sessionVersion: 1, req })

      expect(queryMock).toHaveBeenCalledOnce()
      expect(res.sessionId).toBe('sess-123')
      expect(res.deviceFingerprint).toBe('fp-123')
    })

    it('validates active session and checks revocation', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'sess-123' }] })
      const active = await isSessionActive('sess-123')
      expect(active).toBe(true)

      queryMock.mockResolvedValueOnce({ rows: [] }) // Revoked session
      const revoked = await isSessionActive('sess-revoked')
      expect(revoked).toBe(false)
    })

    it('lists active user sessions and flags current session', async () => {
      const now = new Date()
      queryMock.mockResolvedValueOnce({
        rows: [
          { id: 'sess-1', ip_address: '1.1.1.1', user_agent: 'App', device_type: 'MOBILE_APP', created_at: now, expires_at: now },
          { id: 'sess-2', ip_address: '2.2.2.2', user_agent: 'Web', device_type: 'WEB_DASHBOARD', created_at: now, expires_at: now },
        ],
      })

      const list = await listActiveSessions('u-1', 'sess-1')
      expect(list).toHaveLength(2)
      expect(list[0].isCurrent).toBe(true)
      expect(list[1].isCurrent).toBe(false)
    })

    it('revokes specific session cleanly', async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 1 })
      const success = await revokeSession('sess-1', 'u-1')
      expect(success).toBe(true)
    })

    it('revokes all other sessions except current session', async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 3 })
      const count = await revokeAllOtherSessions('sess-current', 'u-1')
      expect(count).toBe(3)
    })

    it('revokes all user sessions and increments session version', async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 2 }) // Revoke sessions
      queryMock.mockResolvedValueOnce({ rows: [{ session_version: 2 }] }) // Increment version

      const newVersion = await revokeAllUserSessions('u-1')
      expect(newVersion).toBe(2)
    })
  })
})
