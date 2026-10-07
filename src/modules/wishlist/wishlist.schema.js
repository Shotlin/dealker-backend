export const getWishlistSchema = {
  tags: ['Wishlist'],
  summary: 'Get user wishlist',
}

export const addItemSchema = {
  tags: ['Wishlist'],
  summary: 'Add item to wishlist',
  body: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const removeItemSchema = {
  tags: ['Wishlist'],
  summary: 'Remove item from wishlist',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const clearWishlistSchema = {
  tags: ['Wishlist'],
  summary: 'Clear wishlist',
}

export const moveToCartSchema = {
  tags: ['Wishlist'],
  summary: 'Move all wishlist items to cart',
}
