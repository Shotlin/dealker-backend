/**
 * Calculate SQL OFFSET from page + limit
 * @param {{ page?: number, limit?: number }} params
 * @returns {{ offset: number, limit: number }}
 */
export function getOffsetLimit({ page = 1, limit = 20 }) {
  const safePage = Math.max(1, Math.floor(page))
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)))
  return {
    offset: (safePage - 1) * safeLimit,
    limit: safeLimit,
  }
}

/**
 * Build pagination metadata for API response
 * @param {{ page: number, limit: number, total: number }} params
 * @returns {{ page: number, limit: number, total: number, totalPages: number }}
 */
export function buildPagination({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  }
}
