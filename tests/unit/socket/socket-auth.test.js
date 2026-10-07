import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { env } from '../../../src/config/env.js'

// Mock database query BEFORE importing socket auth
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/config/database.js', () => ({
  query: queryMock,
}))

// Mock session validation utility
const isSessionActiveMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/utils/session.js', () => ({
  isSessionActive: isSessionActiveMock,
}))

// Mock logger
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  assertSocketAuth,
  assertSocketPermission,
  assertSocketRole,
  socketAuthMiddleware,
} from '../../../src/socket/auth.js'

describe('Phase 1F Socket Authentication & Authorization Unit Tests', () => {
  const SECRET = env.JWT_ACCESS_SECRET || 'test_secret_32_bytes_long_key_123456789'
  const VALID_USER_ID = '11111111-1111-1111-1111-111111111111'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('socketAuthMiddleware', () => {
    it('rejects connection when handshake contains no token', async () => {
      const socket = { handshake: { auth: {}, headers: {} }, id: 'sock-1' }
      const next = vi.fn()

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }))
    })

    it('rejects connection when token signature is invalid', async () => {
      const socket = { handshake: { auth: { token: 'invalid.jwt.token' } }, id: 'sock-2' }
      const next = vi.fn()

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid or expired token' }))
    })

    it('rejects connection when account is blocked', async () => {
      const token = jwt.sign({ id: VALID_USER_ID, role: 'CUSTOMER' }, SECRET)
      const socket = { handshake: { auth: { token } }, id: 'sock-3' }
      const next = vi.fn()

      queryMock.mockResolvedValueOnce({ rows: [{ is_blocked: true, session_version: 1, platform_role: 'CUSTOMER' }] })

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'ACCOUNT_BLOCKED' }))
    })

    it('rejects connection when session version mismatches', async () => {
      const token = jwt.sign({ id: VALID_USER_ID, role: 'CUSTOMER', session_version: 1 }, SECRET)
      const socket = { handshake: { auth: { token } }, id: 'sock-4' }
      const next = vi.fn()

      queryMock.mockResolvedValueOnce({ rows: [{ is_blocked: false, session_version: 2, platform_role: 'CUSTOMER' }] })

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'SESSION_INVALID' }))
    })

    it('rejects connection when device session is revoked', async () => {
      const token = jwt.sign({ id: VALID_USER_ID, role: 'CUSTOMER', sessionId: 'sess-revoked' }, SECRET)
      const socket = { handshake: { auth: { token } }, id: 'sock-5' }
      const next = vi.fn()

      queryMock.mockResolvedValueOnce({ rows: [{ is_blocked: false, session_version: 1, platform_role: 'CUSTOMER' }] })
      isSessionActiveMock.mockResolvedValueOnce(false)

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'SESSION_INVALID' }))
    })

    it('authenticates valid connection and decorates complete socket context', async () => {
      const token = jwt.sign({ id: VALID_USER_ID, role: 'ADMIN', platform_role: 'ADMIN', session_version: 1, sessionId: 'sess-valid' }, SECRET)
      const socket = { handshake: { auth: { token } }, id: 'sock-6' }
      const next = vi.fn()

      queryMock.mockResolvedValueOnce({ rows: [{ is_blocked: false, session_version: 1, platform_role: 'ADMIN' }] })
      isSessionActiveMock.mockResolvedValueOnce(true)

      await socketAuthMiddleware(socket, next)

      expect(next).toHaveBeenCalledWith() // Called without error
      expect(socket.userId).toBe(VALID_USER_ID)
      expect(socket.roles).toContain('ADMIN')
      expect(socket.permissions).toBeDefined()
      expect(socket.session.id).toBe('sess-valid')
      expect(socket.auth.authenticated).toBe(true)
    })
  })

  describe('Socket Authorization Helpers', () => {
    const mockSocket = {
      auth: { authenticated: true, role: 'ADMIN' },
      userId: VALID_USER_ID,
      roles: ['ADMIN'],
      permissions: ['shops.create', 'vendors.approve'],
    }

    it('assertSocketAuth succeeds for authenticated socket', () => {
      expect(assertSocketAuth(mockSocket)).toBe(true)
      expect(() => assertSocketAuth({ auth: {} })).toThrow('Unauthorized — socket is not authenticated')
    })

    it('assertSocketRole succeeds for allowed roles and throws for disallowed roles', () => {
      expect(assertSocketRole(mockSocket, ['ADMIN', 'SUPER_ADMIN'])).toBe(true)
      expect(() => assertSocketRole(mockSocket, ['CUSTOMER'])).toThrow('Forbidden — insufficient role permissions')
    })

    it('assertSocketPermission succeeds for authorized permissions and throws for missing permissions', () => {
      expect(assertSocketPermission(mockSocket, 'vendors.approve')).toBe(true)
      expect(() => assertSocketPermission(mockSocket, 'recalls.close')).toThrow("Forbidden — requires 'recalls.close' permission")
    })
  })
})
