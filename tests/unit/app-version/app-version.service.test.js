import { describe, expect, it, vi } from 'vitest'
import { AppVersionService } from '../../../src/modules/app-version/app-version.service.js'

function makeRepoMock(row) {
  return {
    getByPlatform: vi.fn().mockResolvedValue(row),
    getAll: vi.fn(),
    update: vi.fn(),
  }
}

function makeRow(overrides = {}) {
  return {
    platform: 'android',
    min_supported_build: 20,
    latest_build: 25,
    latest_version_name: '1.0.3',
    update_message: 'Please update to continue using Bakaloo.',
    store_url: 'https://play.google.com/store/apps/details?id=com.bakaloo.india',
    updated_at: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('AppVersionService.check — force/soft update classification', () => {
  it('forces an update when the client build is below the minimum supported build', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20 }))
    const service = new AppVersionService(repo)

    const result = await service.check('android', 15)

    expect(result.forceUpdate).toBe(true)
    expect(result.softUpdate).toBe(false)
    expect(result.latestVersionName).toBe('1.0.3')
    expect(result.storeUrl).toBe('https://play.google.com/store/apps/details?id=com.bakaloo.india')
  })

  it('soft-prompts (does not force) when the build clears the minimum but is behind the latest', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20, latest_build: 25 }))
    const service = new AppVersionService(repo)

    const result = await service.check('android', 22)

    expect(result.forceUpdate).toBe(false)
    expect(result.softUpdate).toBe(true)
  })

  it('neither forces nor soft-prompts when the build is already the latest', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20, latest_build: 25 }))
    const service = new AppVersionService(repo)

    const result = await service.check('android', 25)

    expect(result.forceUpdate).toBe(false)
    expect(result.softUpdate).toBe(false)
  })

  it('exactly matching the minimum supported build is NOT forced (boundary is inclusive)', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20 }))
    const service = new AppVersionService(repo)

    const result = await service.check('android', 20)

    expect(result.forceUpdate).toBe(false)
  })

  it('fails open (never forces) when the platform has no configured row at all', async () => {
    const repo = makeRepoMock(null)
    const service = new AppVersionService(repo)

    const result = await service.check('android', 1)

    expect(result.forceUpdate).toBe(false)
    expect(result.softUpdate).toBe(false)
    expect(result.storeUrl).toBeNull()
  })

  it('fails open (never forces) when the client build number does not parse to a valid number', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20 }))
    const service = new AppVersionService(repo)

    const result = await service.check('android', Number.NaN)

    expect(result.forceUpdate).toBe(false)
    expect(result.softUpdate).toBe(false)
  })

  it('fails open (never forces) for a zero or negative build number rather than treating it as "very old"', async () => {
    const repo = makeRepoMock(makeRow({ min_supported_build: 20 }))
    const service = new AppVersionService(repo)

    const zero = await service.check('android', 0)
    const negative = await service.check('android', -5)

    expect(zero.forceUpdate).toBe(false)
    expect(negative.forceUpdate).toBe(false)
  })
})

describe('AppVersionService.update / listAll — camelCase formatting round-trip', () => {
  it('update() returns the camelCase-formatted row from the repository', async () => {
    const repo = makeRepoMock(null)
    repo.update.mockResolvedValue(makeRow({ min_supported_build: 30 }))
    const service = new AppVersionService(repo)

    const result = await service.update('android', {
      minSupportedBuild: 30,
      latestBuild: 30,
      latestVersionName: '1.0.4',
    })

    expect(result.minSupportedBuild).toBe(30)
    expect(repo.update).toHaveBeenCalledWith('android', {
      minSupportedBuild: 30,
      latestBuild: 30,
      latestVersionName: '1.0.4',
    })
  })

  it('listAll() formats every row to camelCase', async () => {
    const repo = makeRepoMock(null)
    repo.getAll.mockResolvedValue([makeRow({ platform: 'android' }), makeRow({ platform: 'ios' })])
    const service = new AppVersionService(repo)

    const result = await service.listAll()

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.platform)).toEqual(['android', 'ios'])
    expect(result[0].minSupportedBuild).toBe(20)
  })
})
