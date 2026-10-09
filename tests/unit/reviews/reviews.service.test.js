import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheDeletePattern: vi.fn(async () => undefined),
}))

const { ReviewsService } = await import('../../../src/modules/reviews/reviews.service.js')

function makeRepository(overrides = {}) {
  return {
    checkUserOrder: vi.fn(async () => true),
    getReviewByOrder: vi.fn(async () => undefined),
    createReview: vi.fn(async () => ({ id: 'review-1', product_id: 'product-1' })),
    getReviewById: vi.fn(async () => ({ id: 'review-1', user_id: 'user-1', product_id: 'product-1', rating: 4, comment: 'Good', status: 'PUBLISHED' })),
    getAutoPublish: vi.fn(async () => false),
    recomputeVendorRating: vi.fn(async () => undefined),
    checkUserVendorOrder: vi.fn(async () => true),
    getVendorReviewByOrder: vi.fn(async () => undefined),
    createVendorReview: vi.fn(async () => ({ id: 'vreview-1', vendor_id: 'vendor-1' })),
    reportReview: vi.fn(async () => ({ found: true, own: false, created: true })),
    updateReview: vi.fn(async () => ({ id: 'review-1' })),
    deleteReview: vi.fn(async () => undefined),
    recomputeProductRating: vi.fn(async () => undefined),
    getReviewsByOrder: vi.fn(async () => []),
    ...overrides,
  }
}

describe('ReviewsService.createReview', () => {
  it('rejects a review for an order the user never actually received (checkUserOrder now gates on DELIVERED)', async () => {
    const repository = makeRepository({ checkUserOrder: vi.fn(async () => false) })
    const service = new ReviewsService(repository)

    await expect(
      service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 5 })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'You can only review products from orders that have been delivered to you',
    })
    expect(repository.createReview).not.toHaveBeenCalled()
  })

  it('puts a new review into moderation: not counted in the product rating yet', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 4, comment: 'Good' })

    expect(repository.createReview).toHaveBeenCalledWith('user-1', expect.objectContaining({ status: 'SUBMITTED' }))
    expect(repository.recomputeProductRating).not.toHaveBeenCalled()
  })

  it('with auto-publish on, the review goes live and the product rating is recomputed', async () => {
    const repository = makeRepository({ getAutoPublish: vi.fn(async () => true) })
    const service = new ReviewsService(repository)

    await service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 4, comment: 'Good' })

    expect(repository.createReview).toHaveBeenCalledWith('user-1', expect.objectContaining({ status: 'PUBLISHED' }))
    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })

  it('never recomputes when the duplicate-review guard rejects the create', async () => {
    const repository = makeRepository({ getReviewByOrder: vi.fn(async () => ({ id: 'existing' })) })
    const service = new ReviewsService(repository)

    await expect(
      service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 5 })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'You have already reviewed this product for this order',
    })
    expect(repository.recomputeProductRating).not.toHaveBeenCalled()
  })
})

describe('ReviewsService.updateReview', () => {
  it('recomputes the product rating when the rating itself changes', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.updateReview('user-1', 'review-1', { rating: 2 })

    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })

  it('sends an edited review back to moderation and drops it out of the rating', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.updateReview('user-1', 'review-1', { comment: 'Edited comment only' })

    expect(repository.updateReview).toHaveBeenCalledWith('review-1', expect.objectContaining({ status: 'SUBMITTED' }))
    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })

  it('leaves an unchanged review alone', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.updateReview('user-1', 'review-1', { rating: 4, comment: 'Good' })

    expect(repository.updateReview).toHaveBeenCalledWith('review-1', expect.objectContaining({ status: undefined }))
    expect(repository.recomputeProductRating).not.toHaveBeenCalled()
  })

  it('refuses edits to a hidden or removed review', async () => {
    for (const status of ['HIDDEN', 'REMOVED']) {
      const repository = makeRepository({ getReviewById: vi.fn(async () => ({ id: 'review-1', user_id: 'user-1', product_id: 'product-1', rating: 4, status })) })
      const service = new ReviewsService(repository)

      await expect(service.updateReview('user-1', 'review-1', { comment: 'again' })).rejects.toMatchObject({ statusCode: 403 })
      expect(repository.updateReview).not.toHaveBeenCalled()
    }
  })
})

describe('ReviewsService.deleteReview', () => {
  it('recomputes the product rating after deleting', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.deleteReview('user-1', 'review-1')

    expect(repository.deleteReview).toHaveBeenCalledWith('review-1')
    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })
})

describe('ReviewsService.getReviewsByOrder', () => {
  it('passes the userId and orderId straight through to the repository', async () => {
    const existing = [{ product_id: 'product-1', rating: 5, comment: 'Great!' }]
    const repository = makeRepository({ getReviewsByOrder: vi.fn(async () => existing) })
    const service = new ReviewsService(repository)

    const result = await service.getReviewsByOrder('user-1', 'order-1')

    expect(repository.getReviewsByOrder).toHaveBeenCalledWith('user-1', 'order-1')
    expect(result).toBe(existing)
  })
})

describe('ReviewsService.deleteReview moderation guard', () => {
  it('does not let a customer delete a removed review to dodge the decision', async () => {
    const repository = makeRepository({ getReviewById: vi.fn(async () => ({ id: 'review-1', user_id: 'user-1', product_id: 'product-1', status: 'REMOVED' })) })
    const service = new ReviewsService(repository)

    await expect(service.deleteReview('user-1', 'review-1')).rejects.toMatchObject({ statusCode: 403 })
    expect(repository.deleteReview).not.toHaveBeenCalled()
  })
})

describe('ReviewsService vendor reviews + reports', () => {
  it('requires a received order from that vendor', async () => {
    const repository = makeRepository({ checkUserVendorOrder: vi.fn(async () => false) })
    const service = new ReviewsService(repository)

    await expect(service.createVendorReview('user-1', { vendorId: 'vendor-1', orderId: 'order-1', rating: 5 })).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.createVendorReview).not.toHaveBeenCalled()
  })

  it('rejects out-of-range or fractional ratings and duplicate reviews', async () => {
    const service = new ReviewsService(makeRepository({ getVendorReviewByOrder: vi.fn(async () => ({ id: 'x' })) }))

    for (const rating of [0, 6, 3.5]) {
      await expect(service.createVendorReview('user-1', { vendorId: 'vendor-1', orderId: 'order-1', rating })).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(service.createVendorReview('user-1', { vendorId: 'vendor-1', orderId: 'order-1', rating: 5 })).rejects.toMatchObject({
      message: 'You have already reviewed this seller for this order',
    })
  })

  it('waits for moderation by default; recomputes the seller rating only when auto-published', async () => {
    let repository = makeRepository()
    await new ReviewsService(repository).createVendorReview('user-1', { vendorId: 'vendor-1', orderId: 'order-1', rating: 5 })
    expect(repository.createVendorReview).toHaveBeenCalledWith('user-1', expect.objectContaining({ status: 'SUBMITTED' }))
    expect(repository.recomputeVendorRating).not.toHaveBeenCalled()

    repository = makeRepository({ getAutoPublish: vi.fn(async () => true) })
    await new ReviewsService(repository).createVendorReview('user-1', { vendorId: 'vendor-1', orderId: 'order-1', rating: 5 })
    expect(repository.recomputeVendorRating).toHaveBeenCalledWith('vendor-1')
  })

  it('reports need a real reason, and map missing/own reviews to clear errors', async () => {
    await expect(new ReviewsService(makeRepository()).reportReview('user-1', 'PRODUCT', 'review-1', ' ')).rejects.toMatchObject({ statusCode: 400 })
    await expect(new ReviewsService(makeRepository({ reportReview: vi.fn(async () => ({ found: false })) })).reportReview('user-1', 'PRODUCT', 'review-1', 'spam')).rejects.toMatchObject({ statusCode: 404 })
    await expect(new ReviewsService(makeRepository({ reportReview: vi.fn(async () => ({ found: true, own: true })) })).reportReview('user-1', 'PRODUCT', 'review-1', 'spam')).rejects.toMatchObject({ statusCode: 400 })
    await expect(new ReviewsService(makeRepository()).reportReview('user-1', 'PRODUCT', 'review-1', 'spam')).resolves.toEqual({ reported: true })
  })
})
