import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { env } from '../../config/env.js'
import { UploadsService } from './uploads.service.js'
import { resolveUploadFolder } from './upload-folders.js'

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
export const PUBLIC_BASE = (process.env.UPLOADS_PUBLIC_URL || 'http://localhost:4500/uploads').replace(/\/$/, '')
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const cloudinaryEnabled = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)

/**
 * Image uploads for dashboard/app clients.
 * POST /api/v1/uploads/local  (multipart, up to 8 images, 5 MB each) → { urls: [...] }
 * Optional `?kind=` (product, banner, category, brand, shop, icon, theme, store, listing...) picks the
 * Cloudinary folder. Goes to Cloudinary when credentials are configured; otherwise to local disk,
 * served from /uploads/*.
 */
export default async function localUploadRoutes(fastify) {
  const cloudinaryUploads = new UploadsService()

  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const urls = []
    if (cloudinaryEnabled()) {
      for await (const part of req.files({ limits: { files: 8, fileSize: MAX_IMAGE_BYTES } })) {
        if (!ALLOWED[part.mimetype]) {
          part.file.resume()
          return reply.code(400).send({ success: false, message: 'Only JPG, PNG or WebP images are allowed' })
        }
        let buffer
        try {
          buffer = await part.toBuffer()
        } catch (err) {
          if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(413).send({ success: false, message: 'Image is larger than 5 MB' })
          }
          throw err
        }
        try {
          const result = await cloudinaryUploads.uploadImage(Readable.from(buffer), {
            folder: resolveUploadFolder(req.query?.kind, 'misc'),
          })
          urls.push(result.url)
        } catch (err) {
          req.log.error({ err }, 'Cloudinary image upload failed')
          return reply.code(502).send({ success: false, message: 'Image upload failed. Please try again.' })
        }
      }
      if (!urls.length) return reply.code(400).send({ success: false, message: 'No image received' })
      return { success: true, data: { urls } }
    }

    const dir = path.join(UPLOAD_DIR, new Date().toISOString().slice(0, 7))
    await fs.promises.mkdir(dir, { recursive: true })
    for await (const part of req.files({ limits: { files: 8, fileSize: MAX_IMAGE_BYTES } })) {
      const ext = ALLOWED[part.mimetype]
      if (!ext) {
        part.file.resume()
        return reply.code(400).send({ success: false, message: 'Only JPG, PNG or WebP images are allowed' })
      }
      const name = `${crypto.randomUUID()}.${ext}`
      await pipeline(part.file, fs.createWriteStream(path.join(dir, name)))
      if (part.file.truncated) {
        await fs.promises.unlink(path.join(dir, name)).catch(() => {})
        return reply.code(413).send({ success: false, message: 'Image is larger than 5 MB' })
      }
      urls.push(`${PUBLIC_BASE}/${path.basename(dir)}/${name}`)
    }
    if (!urls.length) return reply.code(400).send({ success: false, message: 'No image received' })
    return { success: true, data: { urls } }
  })
}
