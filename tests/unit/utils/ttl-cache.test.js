import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from '../../../src/utils/ttl-cache.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('createTtlCache', () => {
  it('shares ONE load between concurrent callers (a 15-request burst = 1 lookup)', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    const loader = vi.fn(async () => { await tick(10); return 'v' })
    const out = await Promise.all(Array.from({ length: 15 }, () => cache.get('k', loader)))
    expect(out).toEqual(Array(15).fill('v'))
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('serves from memory until the TTL passes, then reloads', async () => {
    const cache = createTtlCache({ ttlMs: 30 })
    const loader = vi.fn(async () => Math.random())
    const a = await cache.get('k', loader)
    expect(await cache.get('k', loader)).toBe(a)
    expect(loader).toHaveBeenCalledTimes(1)
    await tick(45)
    await cache.get('k', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('is a pass-through when the TTL is 0 (and reads a function TTL on every call)', async () => {
    let ttl = 0
    const cache = createTtlCache({ ttlMs: () => ttl })
    const loader = vi.fn(async () => 1)
    await cache.get('k', loader)
    await cache.get('k', loader)
    expect(loader).toHaveBeenCalledTimes(2)
    ttl = 1000
    await cache.get('k', loader)
    await cache.get('k', loader)
    expect(loader).toHaveBeenCalledTimes(3)
  })

  it('never caches errors', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce('ok')
    await expect(cache.get('k', loader)).rejects.toThrow('db down')
    expect(await cache.get('k', loader)).toBe('ok')
  })

  it('survives a loader that throws synchronously', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    await expect(cache.get('k', () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await cache.get('k', async () => 'fine')).toBe('fine')
  })

  it('cacheIf can refuse to remember a result (but still returns it)', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    const loader = vi.fn(async () => [])
    expect(await cache.get('k', loader, (v) => v.length > 0)).toEqual([])
    await cache.get('k', loader, (v) => v.length > 0)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('invalidate() drops the entry, and a load that started BEFORE it is not stored AFTER it', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    let release
    const slow = vi.fn(() => new Promise((r) => { release = () => r('old') }))
    const first = cache.get('k', slow)
    await tick() // let the loader start
    cache.invalidate('k') // e.g. the user was just blocked while the lookup was in flight
    release()
    expect(await first).toBe('old')
    const fresh = vi.fn(async () => 'new')
    expect(await cache.get('k', fresh)).toBe('new') // the stale 'old' was NOT remembered
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('invalidatePrefix() drops every key of one user only', async () => {
    const cache = createTtlCache({ ttlMs: 1000 })
    await cache.get('u1:a', async () => 1)
    await cache.get('u1:b', async () => 2)
    await cache.get('u2:a', async () => 3)
    cache.invalidatePrefix('u1:')
    expect(cache.size).toBe(1)
    const loader = vi.fn(async () => 9)
    expect(await cache.get('u2:a', loader)).toBe(3)
    expect(loader).not.toHaveBeenCalled()
  })

  it('stays bounded by max (oldest entry goes first)', async () => {
    const cache = createTtlCache({ ttlMs: 1000, max: 3 })
    for (const k of ['a', 'b', 'c', 'd']) await cache.get(k, async () => k)
    expect(cache.size).toBe(3)
    const loader = vi.fn(async () => 'again')
    await cache.get('a', loader)
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
