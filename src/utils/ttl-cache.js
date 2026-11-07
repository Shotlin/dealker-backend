/**
 * Tiny in-process TTL cache with in-flight de-duplication.
 *
 * Why it exists: the vendor app opens a screen by firing ~15 requests at the same moment, and every one of them
 * used to repeat the same auth / vendor-scope lookups. With this, a burst costs ONE lookup, and the next few
 * seconds cost none. Entries are tiny (a few booleans), bounded by `max`, and only ever held for `ttlMs`.
 *
 * - `ttlMs` may be a number or a function (read on every call, so tests/ops can change it without a restart).
 *   A TTL <= 0 turns the cache off: every call goes straight to the loader.
 * - Errors are never cached; `cacheIf` lets a caller refuse to cache a particular result.
 * - `invalidate*` also forgets any load that is still in flight, so a value that was read BEFORE a write can never
 *   be stored AFTER it.
 *
 * @module utils/ttl-cache
 */

export function createTtlCache({ ttlMs, max = 5000 } = {}) {
  const store = new Map() // key -> { value, exp }
  const inflight = new Map() // key -> Promise
  let epoch = 0 // bumped by every invalidation; a load that started before it must not be stored

  const ttl = () => {
    const v = typeof ttlMs === 'function' ? ttlMs() : ttlMs
    return Number.isFinite(v) ? v : 0
  }

  /**
   * @param {string} key
   * @param {() => Promise<any>} loader
   * @param {(value:any) => boolean} [cacheIf] return false to hand the value back WITHOUT remembering it
   *   (e.g. never remember "no membership yet", so a vendor who just registered is not locked out)
   */
  async function get(key, loader, cacheIf) {
    const t = ttl()
    if (t <= 0) return loader()

    const hit = store.get(key)
    if (hit) {
      if (hit.exp > Date.now()) return hit.value
      store.delete(key)
    }

    const pending = inflight.get(key)
    if (pending) return pending

    const startedAt = epoch
    const promise = (async () => {
      try {
        // Promise.resolve().then(...) guarantees we always yield once, so `promise` below is assigned before
        // the `finally` runs even if a (non-async) loader throws synchronously.
        const value = await Promise.resolve().then(loader)
        if (startedAt === epoch && (!cacheIf || cacheIf(value))) {
          if (store.size >= max) store.delete(store.keys().next().value) // oldest first
          store.set(key, { value, exp: Date.now() + t })
        }
        return value
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key)
      }
    })()
    inflight.set(key, promise)
    return promise
  }

  return {
    get,
    /** Forget one key. */
    invalidate(key) {
      epoch++
      store.delete(key)
      inflight.delete(key)
    },
    /** Forget every key that starts with `prefix` (e.g. all sessions of one user). */
    invalidatePrefix(prefix) {
      epoch++
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k)
      for (const k of inflight.keys()) if (k.startsWith(prefix)) inflight.delete(k)
    },
    clear() {
      epoch++
      store.clear()
      inflight.clear()
    },
    get size() {
      return store.size
    },
  }
}

/** TTL from an env var in ms; off (0) under vitest unless the test opts in explicitly. */
export function envTtl(name, defaultMs) {
  return () => {
    const raw = process.env[name]
    if (raw !== undefined && raw !== '') return Number(raw)
    return process.env.VITEST ? 0 : defaultMs
  }
}
