import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import {
  buildCloudinaryUrl,
  buildCloudinaryVariants,
  cloudinary,
} from '../../config/cloudinary.js'
import { uploadImageWithCloudinaryFallback } from '../../utils/cloudinary-upload.js'

/**
 * Uploads service — Cloudinary image management
 */
export class UploadsService {
  /**
   * Upload a single image to Cloudinary
   * @param {ReadableStream} fileStream
   * @param {object} options - { folder, publicId }
   * @returns {Promise<{ url: string, publicId: string }>}
   */
  async uploadImage(fileStream, { folder, publicId } = {}) {
    try {
      const result = await uploadImageWithCloudinaryFallback(fileStream, {
        folder: folder || `${env.CLOUDINARY_FOLDER}/products`,
        public_id: publicId,
        resource_type: 'image',
        transformation: [
          { quality: 'auto', fetch_format: 'auto' },
        ],
      })

      const asset = {
        publicId: result.public_id,
        version: result.version,
      }

      return {
        url: buildCloudinaryUrl(asset, 'default'),
        originalUrl: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
        variants: buildCloudinaryVariants(asset),
      }
    } catch (error) {
      logger.error({ err: error }, 'Cloudinary upload failed')
      throw error
    }
  }

  async uploadFile(fileBuffer, filename, folder = 'bakaloo/theme-assets') {
    const safeFilename = `${filename || 'asset'}`
      .trim()
      .replace(/[^\w.-]+/g, '_')

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder,
          public_id: safeFilename,
        },
        (err, result) => {
          if (err) reject(err)
          else resolve({ url: result.secure_url, publicId: result.public_id })
        }
      )
      stream.end(fileBuffer)
    })
  }

  /**
   * Upload a video (procurement quality evidence) to Cloudinary.
   * @param {ReadableStream} fileStream
   * @param {object} options - { folder, publicId }
   * @returns {Promise<{ url: string, publicId: string, duration: number|null, format: string|null, bytes: number|null }>}
   */
  async uploadVideo(fileStream, { folder, publicId } = {}) {
    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: folder || `${env.CLOUDINARY_FOLDER}/evidence`,
            public_id: publicId,
          },
          (err, video) => {
            if (err) reject(err)
            else resolve(video)
          }
        )
        // `fileStream` is a real Readable (the multipart part's stream) —
        // it must be piped, not handed to `.end()`, which requires a
        // Buffer/string for a non-object-mode Writable. `.end(fileStream)`
        // throws instead of uploading anything; see the sibling working
        // pattern in utils/cloudinary-upload.js.
        fileStream.on('error', reject)
        fileStream.pipe(uploadStream)
      })

      return {
        url: result.secure_url,
        publicId: result.public_id,
        duration: result.duration ?? null,
        format: result.format ?? null,
        bytes: result.bytes ?? null,
      }
    } catch (error) {
      logger.error({ err: error }, 'Cloudinary video upload failed')
      throw error
    }
  }

  /**
   * Delete an image from Cloudinary by public_id
   * @param {string} publicId
   */
  async deleteImage(publicId) {
    try {
      const result = await cloudinary.uploader.destroy(publicId)
      logger.info({ publicId, result: result.result }, 'Image deleted from Cloudinary')
      return { success: result.result === 'ok' }
    } catch (err) {
      logger.error({ err, publicId }, 'Failed to delete image from Cloudinary')
      throw err
    }
  }
}
