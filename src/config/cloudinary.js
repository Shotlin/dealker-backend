import { v2 as cloudinary } from 'cloudinary'
import { env } from './env.js'
import { logger } from './logger.js'

const DEFAULT_DELIVERY_TRANSFORM = {
  fetch_format: 'auto',
  quality: 'auto',
  dpr: 'auto',
}

export const CLOUDINARY_DELIVERY_PROFILES = {
  default: [DEFAULT_DELIVERY_TRANSFORM],
  icon: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 96, height: 96, crop: 'fill' }],
  thumb: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 240, height: 240, crop: 'fill' }],
  card: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 640, height: 640, crop: 'fill' }],
  banner: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 1440, height: 720, crop: 'fill' }],
  detail: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 1280, height: 1280, crop: 'limit' }],
  avatar: [{ ...DEFAULT_DELIVERY_TRANSFORM, width: 320, height: 320, crop: 'fill', gravity: 'face' }],
}

function stripFileExtension(pathSegment) {
  return pathSegment.replace(/\.[^/.]+$/, '')
}

function looksLikeTransformationSegment(segment) {
  if (!segment) return false
  return segment.includes(',') || /^[a-z]{1,3}_[^/]+/.test(segment)
}

function extractCloudinaryUrlCandidate(value) {
  if (!value) return null

  const httpsIndex = value.lastIndexOf('https://res.cloudinary.com/')
  const httpIndex = value.lastIndexOf('http://res.cloudinary.com/')
  const startIndex = Math.max(httpsIndex, httpIndex)

  if (startIndex === -1) return null
  return value.slice(startIndex)
}

export function extractCloudinaryAssetInfo(source) {
  if (!source) return null

  if (typeof source === 'object' && source !== null) {
    const publicId = source.publicId || source.public_id
    if (!publicId) return null

    return {
      publicId,
      version: source.version != null ? String(source.version) : null,
    }
  }

  if (typeof source !== 'string') {
    return null
  }

  const trimmed = source.trim()
  if (!trimmed) return null

  const cloudinaryUrlCandidate = extractCloudinaryUrlCandidate(trimmed)
  const candidate = cloudinaryUrlCandidate || trimmed
  const parsed = URL.canParse(candidate) ? new URL(candidate) : null

  if (!parsed) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      return null
    }

    return { publicId: trimmed, version: null }
  }

  if (!parsed.hostname.includes('cloudinary.com')) {
    return null
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  const uploadIndex = segments.indexOf('upload')
  if (uploadIndex === -1) {
    return null
  }

  let version = null
  const assetSegments = segments.slice(uploadIndex + 1)

  while (assetSegments.length > 0) {
    const current = assetSegments[0]
    if (/^v\d+$/.test(current)) {
      version = current.slice(1)
      assetSegments.shift()
      break
    }

    if (looksLikeTransformationSegment(current)) {
      assetSegments.shift()
      continue
    }

    break
  }

  if (assetSegments.length === 0) {
    return null
  }

  assetSegments[assetSegments.length - 1] = stripFileExtension(
    assetSegments[assetSegments.length - 1]
  )

  return {
    publicId: assetSegments.join('/'),
    version,
  }
}

export function isCloudinarySource(source) {
  return extractCloudinaryAssetInfo(source) != null
}

export function buildCloudinaryUrl(source, profile = 'default') {
  const asset = extractCloudinaryAssetInfo(source)
  if (!asset?.publicId || !env.CLOUDINARY_CLOUD_NAME) {
    return typeof source === 'string' ? source : null
  }

  const transformations = CLOUDINARY_DELIVERY_PROFILES[profile] || CLOUDINARY_DELIVERY_PROFILES.default

  return cloudinary.url(asset.publicId, {
    secure: true,
    sign_url: false,
    resource_type: 'image',
    type: 'upload',
    version: asset.version || undefined,
    transformation: transformations,
  })
}

export function buildCloudinaryVariants(source, profiles = ['thumb', 'card', 'detail']) {
  const variants = {}
  for (const profile of profiles) {
    const url = buildCloudinaryUrl(source, profile)
    if (url) {
      variants[profile] = url
    }
  }
  return variants
}

export function normalizeCloudinaryDeliveryUrl(source, profile = 'default') {
  const asset = extractCloudinaryAssetInfo(source)
  if (!asset) {
    return typeof source === 'string' ? source : null
  }

  return buildCloudinaryUrl(asset, profile)
}

if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  if (env.CLOUDINARY_API_SECRET === env.CLOUDINARY_API_KEY) {
    logger.error(
      '⚠️  Cloudinary API secret matches the API key. Signed uploads will fail unless an unsigned upload preset fallback is available.'
    )
  }

  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
  logger.info('✅ Cloudinary configured')
} else {
  logger.warn('⚠️  Cloudinary not configured — image uploads will fail')
}

export { cloudinary }
