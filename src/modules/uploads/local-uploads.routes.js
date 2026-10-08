import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
export const PUBLIC_BASE = (process.env.UPLOADS_PUBLIC_URL || 'http://localhost:4500/uploads').replace(/\/$/, '')
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/**
 * Local-disk image uploads (used when Cloudinary is not configured).
 * POST /api/v1/uploads/local  (multipart, up to 8 images, 5 MB each) → { urls: [...] }
 * Files are served from /uploads/*.
 */
export default async function localUploadRoutes(fastify) {
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const urls = []
    const dir = path.join(UPLOAD_DIR, new Date().toISOString().slice(0, 7))
    await fs.promises.mkdir(dir, { recursive: true })
    for await (const part of req.files({ limits: { files: 8, fileSize: 5 * 1024 * 1024 } })) {
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
