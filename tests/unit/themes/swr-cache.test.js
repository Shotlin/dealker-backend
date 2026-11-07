import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
const redisMock = {
  get: vi.fn(async (k) => store.get(k) ?? null),
  set: vi.fn(async (k, v) => { store.set(k, v); return 'OK' }),
}

vi.mock('../../../src/config/redis.js', () => ({ redis: redisMock }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { readThrough, singleFlight } = await import('../../../src/utils/swr-cache.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('singleFlight', () => {
  it('runs one build for concurrent callers of the same key', async () => {
    let calls = 0
    const build = async () => { calls += 1; await tick(); return 'v' }
    const results = await Promise.all([singleFlight('k', build), singleFlight('k', build), singleFlight('k', build)])
    expect(results).toEqual(['v', 'v', 'v'])
    expect(calls).toBe(1)
  })

  it('allows a new build once the previous one finished', async () => {
    let calls = 0
    const build = async () => { calls += 1; return calls }
    await singleFlight('k2', build)
    await singleFlight('k2', build)
    expect(calls).toBe(2)
  })
})

describe('readThrough', () => {
  beforeEach(() => {
    store.clear()
    redisMock.get.mockClear()
    redisMock.set.mockClear()
  })

  it('builds once for a burst of cold requests and caches the result', async () => {
    let builds = 0
    const build = async () => { builds += 1; await tick(); return { n: 1 } }
    const opts = { key: 'cold', freshSeconds: 300, hardSeconds: 1200, build }

    const burst = await Promise.all([readThrough(opts), readThrough(opts), readThrough(opts), readThrough(opts)])
    expect(builds).toBe(1)
    expect(burst.every((r) => r.value.n === 1 && r.state === 'miss')).toBe(true)
    expect(redisMock.set).toHaveBeenCalledWith('cold', expect.any(String), 'EX', 1200)

    const next = await readThrough(opts)
    expect(next.state).toBe('fresh')
    expect(builds).toBe(1)
  })

  it('serves a stale entry immediately and refreshes it once in the background', async () => {
    store.set('stale', JSON.stringify({ _swr: Date.now() - 400_000, value: { v: 'old' } }))
    let builds = 0
    const build = async () => { builds += 1; await tick(); return { v: 'new' } }
    const opts = { key: 'stale', freshSeconds: 300, hardSeconds: 1200, build }

    const [a, b] = await Promise.all([readThrough(opts), readThrough(opts)])
    expect(a).toEqual({ value: { v: 'old' }, state: 'stale' })
    expect(b.state).toBe('stale')

    await tick(); await tick(); await tick()
    expect(builds).toBe(1)
    const after = await readThrough(opts)
    expect(after).toEqual({ value: { v: 'new' }, state: 'fresh' })
  })

  it('treats entries written by the old code (no stamp) as fresh', async () => {
    store.set('legacy', JSON.stringify({ _etag: 'abc', data: { x: 1 } }))
    const build = vi.fn()
    const res = await readThrough({ key: 'legacy', freshSeconds: 300, hardSeconds: 1200, build })
    expect(res).toEqual({ value: { _etag: 'abc', data: { x: 1 } }, state: 'fresh' })
    expect(build).not.toHaveBeenCalled()
  })

  it('does not cache a null build (e.g. unknown tab) and lets every waiter see it', async () => {
    const build = vi.fn(async () => null)
    const res = await readThrough({ key: 'nope', freshSeconds: 300, hardSeconds: 1200, build })
    expect(res.value).toBeNull()
    expect(redisMock.set).not.toHaveBeenCalled()
  })

  it('keeps serving the stale value if the background refresh fails', async () => {
    store.set('flaky', JSON.stringify({ _swr: Date.now() - 400_000, value: { v: 'old' } }))
    const build = vi.fn(async () => { throw new Error('db down') })
    const res = await readThrough({ key: 'flaky', freshSeconds: 300, hardSeconds: 1200, build })
    expect(res.value).toEqual({ v: 'old' })
    await tick(); await tick()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('falls back to building when Redis is unavailable', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('redis down'))
    const res = await readThrough({ key: 'r', freshSeconds: 300, hardSeconds: 1200, build: async () => ({ ok: true }) })
    expect(res.value).toEqual({ ok: true })
  })
})
