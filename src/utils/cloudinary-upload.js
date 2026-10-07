import { Readable } from 'stream'

import { cloudinary } from '../config/cloudinary.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

function isInvalidSignatureError(error) {
  return error?.http_code === 401 && /Invalid Signature/i.test(error?.message || '')
}

async function streamToBuffer(fileStream) {
  const chunks = []
  for await (const chunk of fileStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function uploadBufferSigned(buffer, options) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error)
        return
      }
      resolve(result)
    })

    Readable.from(buffer).pipe(uploadStream)
  })
}

function uploadBufferUnsigned(buffer, options) {
  return new Promise((resolve, reject) => {
    const unsignedOptions = {
      ...options,
    }

    delete unsignedOptions.public_id
    delete unsignedOptions.overwrite

    const uploadStream = cloudinary.uploader.unsigned_upload_stream(
      env.CLOUDINARY_UPLOAD_PRESET,
      (error, result) => {
        if (error) {
          reject(error)
          return
        }
        resolve(result)
      },
      unsignedOptions
    )

    Readable.from(buffer).pipe(uploadStream)
  })
}

export async function uploadImageWithCloudinaryFallback(fileStream, options) {
  const buffer = await streamToBuffer(fileStream)

  try {
    return await uploadBufferSigned(buffer, options)
  } catch (error) {
    if (!isInvalidSignatureError(error) || !env.CLOUDINARY_UPLOAD_PRESET) {
      throw error
    }

    logger.warn(
      {
        folder: options.folder,
        uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
      },
      'Cloudinary signed upload failed with invalid signature. Retrying with unsigned preset.'
    )

    return uploadBufferUnsigned(buffer, options)
  }
}

/**
 * Vendor quality-video evidence is very often recorded on an iPhone, which
 * defaults to HEVC/H.265 (`codecs=hvc1`) — confirmed live: a real evidence
 * asset's own `Content-Type` came back `video/mp4;codecs=hvc1`. Android's
 * `video_player`/ExoPlayer HEVC support is inconsistent across devices, and
 * a real customer report ("Watch Video" spins or never renders) traced
 * directly to exactly this codec. Cloudinary can transcode on the fly via
 * a `vc_h264` delivery transformation segment in the URL — inserted here
 * so every consumer (mobile app, admin dashboard) gets a broadly-
 * compatible H.264 stream without re-uploading or re-encoding the
 * original asset. A non-Cloudinary or malformed URL is returned unchanged.
 */
export function toH264VideoUrl(url) {
  if (!url || typeof url !== 'string') return url
  const marker = '/video/upload/'
  const idx = url.indexOf(marker)
  if (idx === -1) return url
  const insertAt = idx + marker.length
  return `${url.slice(0, insertAt)}vc_h264/${url.slice(insertAt)}`
}

