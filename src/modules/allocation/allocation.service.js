import { cacheGet, cacheSet, cacheDel } from "../../utils/cache.js";
import { logger } from "../../config/logger.js";
import { allocationQueue } from "../../config/bullmq.js";
import { cleanPincode } from "../../utils/pincode.js";

/**
 * Allocation service — pure business logic for user-shop allocation.
 *
 * Responsibilities (Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8):
 *   - Pincode-match candidate set (GIN-backed query)
 *   - Haversine radius-match candidate set
 *   - Merge + dedup by shop_id (Property 5)
 *   - Mark closest as primary; tie-break by earliest created_at (Req 4.4)
 *   - Atomic replace of allocations in a transaction (delegated to repo)
 *   - Redis cache for `bakaloo:allocation:v1:{user_id}` (TTL 600s)
 *   - Enqueue BullMQ `recompute-by-shop` jobs for shop area changes
 *
 * The service does no IO except via the repository, the cache utility, and
 * the BullMQ producer — keeping the controller and worker thin.
 */

const CACHE_PREFIX = "bakaloo:allocation:v1";
const CACHE_TTL_SECONDS = 600;

export class AllocationService {
  /**
   * @param {import('./allocation.repository.js').AllocationRepository} repository
   * @param {object} [opts]
   * @param {{add: Function}} [opts.queue] - BullMQ queue (defaults to the
   *   shared allocationQueue). Injectable for tests.
   */
  constructor(repository, opts = {}) {
    this.repo = repository;
    this.queue = opts.queue || allocationQueue;
  }

  // ────────────────────────────────────────────────────────
  // Cache helpers
  // ────────────────────────────────────────────────────────

  cacheKeyFor(userId) {
    return `${CACHE_PREFIX}:${userId}`;
  }

  async invalidateUserCache(userId) {
    if (!userId) return;
    await cacheDel(this.cacheKeyFor(userId));
  }

  // ────────────────────────────────────────────────────────
  // Public read — cached
  // ────────────────────────────────────────────────────────

  /**
   * Fetch the user's allocations, with Redis caching (TTL 600s).
   * Returns a stable shape for the GET /my-shops endpoint (Requirement 4.5).
   *
   * @param {string} userId
   * @returns {Promise<{shops: Array<{
   *   id: string,
   *   shop_id: string,
   *   name: string,
   *   distance_km: number|null,
   *   matched_pincode: string|null,
   *   is_primary: boolean
   * }>}>}
   */
  async getForUser(userId) {
    const cacheKey = this.cacheKeyFor(userId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const rows = await this.repo.findByUserId(userId);
    const result = {
      shops: rows.map((r) => ({
        id: r.id,
        shop_id: r.shop_id,
        name: r.name,
        distance_km:
          r.distance_km !== null && r.distance_km !== undefined
            ? Number(r.distance_km)
            : null,
        matched_pincode: r.matched_pincode,
        is_primary: r.is_primary === true,
      })),
    };

    await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Return just the allocated shop_ids for a user (Requirements 1.5, 4.5,
   * 11.5). Reuses the same Redis-cached payload as `getForUser` to avoid a
   * second round-trip on customer-facing product queries.
   *
   * Result is deterministic (sorted in the same order produced by
   * findShopIdsByUserId) so callers can use it as a stable cache-key fragment.
   *
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async getShopIdsForUser(userId) {
    const data = await this.getForUser(userId);
    if (!data || !Array.isArray(data.shops)) return [];
    return data.shops.map((s) => s.shop_id);
  }

  /**
   * The ONE definition of "the shop a customer's storefront is served from":
   * the primary allocation (first allocation if none is flagged), as a
   * one-element list — or [] when the customer has no allocation.
   *
   * A guest's signed storefront token carries exactly the primary shop that
   * `resolveForLocation` picked, so a guest and a signed-in customer at the
   * same location get the SAME list here. Theme, sections, tab-home, banners,
   * products and category products must all derive their shop from this (or
   * from the guest token) — never from `getShopIdsForUser`, which returns every
   * allocated shop and is only for cart/order flows.
   *
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async getStorefrontShopIds(userId) {
    const data = await this.getForUser(userId);
    const shops = Array.isArray(data?.shops) ? data.shops : [];
    const primary = shops.find((shop) => shop.is_primary) ?? shops[0];
    return primary?.shop_id ? [primary.shop_id] : [];
  }

  /**
   * Resolve stores for a location without writing an account allocation.
   * Used by the guest storefront gate: location remains on the device and
   * this method only returns the serviceable store set for a signed session.
   */
  async resolveForLocation(address) {
    const lat = Number(address?.lat);
    const lng = Number(address?.lng);
    // Whitespace-stripped so it compares equal to the (normalised) PINs stored
    // on shops. A missing PIN is not an error: matching falls back to
    // coordinates only, exactly as it does when the client sends no PIN.
    const pincode = cleanPincode(address?.pincode);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        success: false,
        code: "INVALID_LOCATION",
        message: "A valid device location is required",
      };
    }
    const [pincodeMatches, radiusMatches] = await Promise.all([
      pincode
        ? this.repo.findShopsByPincode(pincode, { lat, lng })
        : Promise.resolve([]),
      this.repo.findShopsByRadius(lat, lng),
    ]);
    const resolved = this.mergeAndMarkPrimary({
      pincode,
      pincodeMatches,
      radiusMatches,
    });
    if (resolved.length === 0) {
      return { success: true, data: { shops: [] } };
    }
    const names = await this.repo.findByShopIds(
      resolved.map((item) => item.shop_id),
    );
    const namesById = new Map(names.map((item) => [item.shop_id, item.name]));
    return {
      success: true,
      data: {
        shops: resolved.map((item) => ({
          ...item,
          name: namesById.get(item.shop_id) || "Store",
        })),
      },
    };
  }

  // ────────────────────────────────────────────────────────
  // Pure compute — exported as a method for testability
  // ────────────────────────────────────────────────────────

  /**
   * Merge pincode-matched and radius-matched shop sets, deduplicate by
   * shop_id, and mark the closest as primary (Requirement 4.4).
   *
   * Tie-breaking rules:
   *   1. Smallest distance_km wins (NULL distances rank last)
   *   2. On a tie, the earliest created_at wins
   *
   * Pure: no IO, deterministic for a given input. Used directly by
   * computeAndUpsertForUser and indirectly by Property 5 tests.
   *
   * @param {object} input
   * @param {string} input.pincode
   * @param {Array<{id: string, created_at: string|Date, distance_km: number|null}>} input.pincodeMatches
   * @param {Array<{id: string, created_at: string|Date, distance_km: number}>} input.radiusMatches
   * @returns {Array<{shop_id: string, distance_km: number|null, matched_pincode: string|null, is_primary: boolean}>}
   */
  mergeAndMarkPrimary({ pincode, pincodeMatches, radiusMatches }) {
    const byId = new Map();

    // Insert pincode matches first so their matched_pincode is preserved on dedup.
    for (const row of pincodeMatches) {
      byId.set(row.id, {
        shop_id: row.id,
        distance_km:
          row.distance_km !== null && row.distance_km !== undefined
            ? Number(row.distance_km)
            : null,
        matched_pincode: pincode,
        created_at: row.created_at,
        is_primary: false,
      });
    }

    // Merge in radius matches; if shop already present (by pincode),
    // keep matched_pincode but adopt the haversine distance which is always
    // numeric here. If only radius-matched, matched_pincode stays null.
    for (const row of radiusMatches) {
      const existing = byId.get(row.id);
      const dist = Number(row.distance_km);
      if (existing) {
        // Pincode-matched row may have null distance if coords were missing.
        // Radius rows always carry a numeric distance — prefer it when smaller.
        if (
          existing.distance_km === null ||
          (Number.isFinite(dist) && dist < existing.distance_km)
        ) {
          existing.distance_km = Number.isFinite(dist)
            ? dist
            : existing.distance_km;
        }
      } else {
        byId.set(row.id, {
          shop_id: row.id,
          distance_km: Number.isFinite(dist) ? dist : null,
          matched_pincode: null,
          created_at: row.created_at,
          is_primary: false,
        });
      }
    }

    const merged = Array.from(byId.values());
    if (merged.length === 0) return [];

    // Pick the primary: smallest distance_km, NULLs last; ties broken by
    // earliest created_at (Requirement 4.4).
    let primary = null;
    for (const candidate of merged) {
      if (primary === null) {
        primary = candidate;
        continue;
      }
      const a = primary;
      const b = candidate;
      const aDist = a.distance_km;
      const bDist = b.distance_km;

      // NULL distances rank last
      if (aDist === null && bDist !== null) {
        primary = b;
        continue;
      }
      if (aDist !== null && bDist === null) {
        continue;
      }

      if (aDist !== null && bDist !== null && bDist < aDist) {
        primary = b;
        continue;
      }

      // Tie break: both numeric equal OR both null
      if (aDist === bDist || (aDist === null && bDist === null)) {
        const aCreated = new Date(a.created_at).getTime();
        const bCreated = new Date(b.created_at).getTime();
        if (
          Number.isFinite(bCreated) &&
          Number.isFinite(aCreated) &&
          bCreated < aCreated
        ) {
          primary = b;
        }
      }
    }
    if (primary) primary.is_primary = true;

    // Strip created_at before returning — only persistence fields leak out.
    return merged.map(({ created_at: _omit, ...rest }) => rest);
  }

  // ────────────────────────────────────────────────────────
  // Compute + upsert
  // ────────────────────────────────────────────────────────

  /**
   * Compute allocations for a user and atomically replace existing rows.
   * (Requirements 4.1, 4.2, 4.3, 4.4, 4.6).
   *
   * @param {string} userId
   * @param {{ lat?: number, lng?: number, pincode?: string }} address
   * @returns {Promise<{
   *   success: boolean,
   *   data?: { shops: Array<object> },
   *   message?: string,
   *   code?: string,
   * }>}
   */
  async computeAndUpsertForUser(userId, address) {
    if (!userId) {
      return {
        success: false,
        message: "user_id is required",
        code: "USER_ID_REQUIRED",
      };
    }

    const lat = address?.lat;
    const lng = address?.lng;
    // Same whitespace normalisation the shop side stores its PINs with (see
    // utils/pincode.js) so an exact-string match cannot be defeated by a
    // stray space. Blank counts as "no pincode".
    const pincode = cleanPincode(address?.pincode);

    // Requirement 4.6 — coordinates are mandatory for allocation
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        success: false,
        message: "A complete delivery address with coordinates is required",
        code: "NO_COORDINATES",
      };
    }
    if (
      !pincode ||
      typeof pincode !== "string" ||
      pincode.trim().length === 0
    ) {
      return {
        success: false,
        message: "A complete delivery address with pincode is required",
        code: "NO_PINCODE",
      };
    }

    // Two parallel DB reads — independent so they run in one round-trip.
    const [pincodeMatches, radiusMatches] = await Promise.all([
      this.repo.findShopsByPincode(pincode, { lat, lng }),
      this.repo.findShopsByRadius(lat, lng),
    ]);

    const allocations = this.mergeAndMarkPrimary({
      pincode,
      pincodeMatches,
      radiusMatches,
    });

    await this.repo.replaceForUser(userId, allocations);
    await this.invalidateUserCache(userId);

    logger.info(
      {
        userId,
        action: "allocation_recomputed",
        count: allocations.length,
        primaryShopId: allocations.find((a) => a.is_primary)?.shop_id ?? null,
      },
      "User-shop allocations recomputed",
    );

    // Hydrate via the read path so the response shape matches getForUser
    // (joined name from shops). Avoids a second client trip for callers that
    // need names; note this read also primes the cache.
    return { success: true, data: await this.getForUser(userId) };
  }

  // ────────────────────────────────────────────────────────
  // Producer — enqueue shop area change
  // ────────────────────────────────────────────────────────

  /**
   * Enqueue an allocation recompute for all customers affected by a shop's
   * area change (Requirement 4.8). The job is idempotent per shop within
   * a short window — repeated calls coalesce on the deterministic jobId.
   *
   * Concurrency 2, attempts 3, exponential backoff are configured at the
   * queue level (see config/bullmq.js).
   *
   * @param {string} shopId
   * @returns {Promise<string|null>} BullMQ job id, or null on failure
   */
  async enqueueShopAreaChange(shopId) {
    if (!shopId) return null;
    try {
      const job = await this.queue.add(
        "recompute-by-shop",
        { type: "recompute-by-shop", shopId },
        { jobId: `recompute-by-shop:${shopId}` },
      );
      logger.info(
        { shopId, jobId: job.id, action: "allocation_job_enqueued" },
        "Allocation recompute job enqueued for shop area change",
      );
      return job.id;
    } catch (err) {
      // Don't let a queue outage break a shop update — log and let the caller
      // succeed; recompute can be re-triggered manually.
      logger.error(
        { shopId, err: err.message, action: "allocation_enqueue_failed" },
        "Failed to enqueue allocation recompute job",
      );
      return null;
    }
  }
}
