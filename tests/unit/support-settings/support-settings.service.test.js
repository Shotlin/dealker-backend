import { describe, expect, it, vi } from 'vitest'

/**
 * Centralized brand name / support phone / support email — the one source
 * of truth every mobile "Need Help"/"Contact Us" surface now reads from,
 * replacing the previously hardcoded AppConstants.supportPhone/
 * supportEmail (which could only ever change by shipping a new app build).
 */
import { SupportSettingsService } from '../../../src/modules/support-settings/support-settings.service.js'

function makeService(row = { brand_name: 'FreshCuts', support_phone: '+91 99249 98906', support_email: 'support@freshcuts.in', updated_at: '2026-09-24T00:00:00Z' }) {
  const repository = {
    get: vi.fn(async () => row),
    save: vi.fn(async (data) => ({ ...row, ...data })),
  }
  return { service: new SupportSettingsService(repository), repository }
}

describe('SupportSettingsService.getPublic/getAdmin', () => {
  it('maps the real row to camelCase', async () => {
    const { service } = makeService()
    const view = await service.getPublic()
    expect(view).toEqual({
      brandName: 'FreshCuts', supportPhone: '+91 99249 98906', supportEmail: 'support@freshcuts.in', updatedAt: '2026-09-24T00:00:00Z',
    })
  })

  it('returns null phone/email (never a fabricated placeholder) when genuinely unconfigured', async () => {
    const { service } = makeService({ brand_name: 'FreshCuts', support_phone: null, support_email: null, updated_at: null })
    const view = await service.getPublic()
    expect(view.supportPhone).toBeNull()
    expect(view.supportEmail).toBeNull()
  })

  it('defaults to a sane brand name if the row is somehow missing entirely', async () => {
    const { service } = makeService(null)
    const view = await service.getPublic()
    expect(view.brandName).toBe('FreshCuts')
  })
})

describe('SupportSettingsService.save — validation', () => {
  it('saves a valid phone + email', async () => {
    const { service, repository } = makeService()
    await service.save({ supportPhone: '+91 99249 98906', supportEmail: 'help@freshcuts.in' })
    expect(repository.save).toHaveBeenCalledWith(
      { support_phone: '+91 99249 98906', support_email: 'help@freshcuts.in' },
      null
    )
  })

  it('rejects an invalid email', async () => {
    const { service, repository } = makeService()
    await expect(service.save({ supportEmail: 'not-an-email' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects an invalid phone number', async () => {
    const { service, repository } = makeService()
    await expect(service.save({ supportPhone: 'call me maybe' })).rejects.toMatchObject({ code: 'INVALID_PHONE' })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects an empty brand name', async () => {
    const { service } = makeService()
    await expect(service.save({ brandName: '   ' })).rejects.toMatchObject({ code: 'INVALID_BRAND_NAME' })
  })

  it('allows clearing phone/email with an empty string (so the mobile app hides that row)', async () => {
    const { service, repository } = makeService()
    await service.save({ supportPhone: '', supportEmail: '' })
    expect(repository.save).toHaveBeenCalledWith({ support_phone: null, support_email: null }, null)
  })

  it('records which admin made the change', async () => {
    const { service, repository } = makeService()
    await service.save({ brandName: 'FreshCuts' }, 'admin-1')
    expect(repository.save).toHaveBeenCalledWith({ brand_name: 'FreshCuts' }, 'admin-1')
  })

  it('does not touch the repository at all when nothing changed', async () => {
    const { service, repository } = makeService()
    await service.save({})
    expect(repository.save).not.toHaveBeenCalled()
  })
})
