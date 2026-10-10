import { env } from '../../config/env.js'

/**
 * Cloudinary folder layout: <CLOUDINARY_FOLDER>/<kind folder>[/<sub>].
 * Clients pass `?kind=<key>` on upload requests; unknown or missing kinds land in `misc`.
 *   dealker/products  dealker/banners  dealker/categories  dealker/brands  dealker/shops
 *   dealker/avatars   dealker/icons    dealker/themes      dealker/stores  dealker/notifications
 *   dealker/listings  dealker/uploads (generic)            dealker/misc
 */
export const UPLOAD_KINDS = {
  product: 'products',
  banner: 'banners',
  category: 'categories',
  brand: 'brands',
  shop: 'shops',
  avatar: 'avatars',
  icon: 'icons',
  theme: 'themes',
  store: 'stores',
  notification: 'notifications',
  listing: 'listings',
  misc: 'misc',
}

export function resolveUploadFolder(kind, fallbackKind = 'misc') {
  const key = typeof kind === 'string' && Object.hasOwn(UPLOAD_KINDS, kind) ? kind : fallbackKind
  return `${env.CLOUDINARY_FOLDER}/${UPLOAD_KINDS[key]}`
}
