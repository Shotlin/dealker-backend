/**
 * Media cleanup — real Postgres triggers + real Cloudinary. Replacing / clearing / deleting an image
 * must remove the old file from Cloudinary; files still referenced elsewhere must survive.
 *
 *   docker exec dealker-postgres-1 psql -U dealker_user -d postgres -c "CREATE DATABASE media_cleanup_test"
 *   MEDIA_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=media_cleanup_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_PORT=6380 JWT_ACCESS_SECRET=... (see dealker-test-setup) \
 *   CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
 *   npx vitest run tests/integration/media-cleanup.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

const ready = process.env.MEDIA_TEST_DB && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_SECRET
const d = ready ? describe : describe.skip

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

d('media cleanup', () => {
  let q, cloudinary, sweep, uploads, resolveUploadFolder, pool
  const uploaded = []
  const tag = crypto.randomBytes(4).toString('hex')

  const upload = async (kind) => {
    const r = await uploads.uploadImage(Readable.from(PNG), { folder: resolveUploadFolder(kind), publicId: `t_${tag}_${uploaded.length}` })
    uploaded.push(r.publicId)
    return r
  }
  const exists = (publicId) => cloudinary.api.resource(publicId).then(() => true, (e) => (e?.error?.http_code === 404 || e?.http_code === 404 ? false : Promise.reject(e)))
  const makeDue = () => q('UPDATE media_deletion_queue SET run_after = NOW()')
  const cat = (image) => q('INSERT INTO categories (name, slug, image_url) VALUES ($1, $2, $3) RETURNING id', [`c-${tag}`, `c-${tag}-${crypto.randomBytes(3).toString('hex')}`, image]).then((r) => r.rows[0].id)

  beforeAll(async () => {
    ;({ query: q, pool } = await import('../../src/config/database.js'))
    ;({ cloudinary } = await import('../../src/config/cloudinary.js'))
    ;({ sweepMediaQueue: sweep } = await import('../../src/modules/uploads/media-cleanup.js'))
    ;({ resolveUploadFolder } = await import('../../src/modules/uploads/upload-folders.js'))
    const { UploadsService } = await import('../../src/modules/uploads/uploads.service.js')
    uploads = new UploadsService()
  }, 60_000)

  afterAll(async () => {
    await Promise.all(uploaded.map((id) => cloudinary.uploader.destroy(id).catch(() => {})))
    await q(`DELETE FROM categories WHERE name = $1`, [`c-${tag}`])
    await pool?.end()
  })

  it('puts each kind in its own folder', async () => {
    const a = await upload('banner')
    const b = await upload('category')
    expect(a.publicId).toMatch(/\/banners\/t_/)
    expect(b.publicId).toMatch(/\/categories\/t_/)
  }, 60_000)

  it('deletes the old file when an image is replaced, keeps the new one', async () => {
    const oldImg = await upload('category')
    const newImg = await upload('category')
    const id = await cat(oldImg.url)
    await q('UPDATE categories SET image_url = $2 WHERE id = $1', [id, newImg.url])
    await makeDue()
    await sweep()
    expect(await exists(oldImg.publicId)).toBe(false)
    expect(await exists(newImg.publicId)).toBe(true)
  }, 90_000)

  it('deletes the file when the image is cleared and when the row is deleted', async () => {
    const a = await upload('category')
    const b = await upload('category')
    const idA = await cat(a.url)
    const idB = await cat(b.url)
    await q('UPDATE categories SET image_url = NULL WHERE id = $1', [idA])
    await q('DELETE FROM categories WHERE id = $1', [idB])
    await makeDue()
    await sweep()
    expect(await exists(a.publicId)).toBe(false)
    expect(await exists(b.publicId)).toBe(false)
  }, 90_000)

  it('never deletes a file another row still uses', async () => {
    const shared = await upload('category')
    const id1 = await cat(shared.url)
    const id2 = await cat(shared.url)
    await q('DELETE FROM categories WHERE id = $1', [id1])
    await makeDue()
    await sweep()
    expect(await exists(shared.publicId)).toBe(true)
    await q('DELETE FROM categories WHERE id = $1', [id2])
    await makeDue()
    await sweep()
    expect(await exists(shared.publicId)).toBe(false)
  }, 90_000)

  it('treats a re-versioned URL of the same asset as unchanged', async () => {
    const img = await upload('category')
    const id = await cat(img.url)
    await q('UPDATE categories SET image_url = $2 WHERE id = $1', [id, img.originalUrl])
    await makeDue()
    await sweep()
    expect(await exists(img.publicId)).toBe(true)
  }, 60_000)

  it('ignores external and out-of-folder URLs', async () => {
    const id = await cat('https://picsum.photos/seed/x/600/600')
    await q('DELETE FROM categories WHERE id = $1', [id])
    await q(`INSERT INTO media_deletion_queue (url, source, run_after) VALUES ($1, 'test', NOW())`, [`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/some-other-app/x.png`])
    await sweep()
    const { rows } = await q('SELECT count(*)::int AS n FROM media_deletion_queue')
    expect(rows[0].n).toBe(0)
  }, 30_000)
})
