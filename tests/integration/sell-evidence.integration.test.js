/**
 * Sell/Exchange request evidence (photos + QC video) and request-level QC — real app, real Postgres,
 * real files on disk, real multipart bodies.
 *
 *   docker exec dealker-postgres-1 psql -U dealker_user -d postgres -c "CREATE DATABASE sell_evidence_test"
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=sell_evidence_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_HOST=localhost REDIS_PORT=6380 \
 *   npx vitest run tests/integration/sell-evidence.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip

// ── real file bytes ─────────────────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const jpeg = (n = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), crypto.randomBytes(64)])
const mp4 = (n = 50_000) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from([0, 0, 0, 0]), Buffer.from('mp42isom'), crypto.randomBytes(n)])
const mov = () => Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8), crypto.randomBytes(4000)])
const heic = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16), crypto.randomBytes(500)])
const html = Buffer.from('<html><script>alert(1)</script></html>')

function multipart(files) {
  const boundary = '----t' + crypto.randomBytes(8).toString('hex')
  const chunks = []
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

d('sell request evidence + QC', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const auth = (t, extra = {}) => ({ authorization: `Bearer ${t}`, ...extra })
  const qa = { ageMonths: 12, screenScratches: 'MINOR', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: false, chargerAvailable: true, batteryHealth: 88, powersOn: true }
  const uniq14 = () => String(35000000000000 + Math.floor(Math.random() * 9e12))
  const luhn = (body) => { for (let c = 0; c < 10; c++) { const s = body + c; let sum = 0; for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n } if (sum % 10 === 0) return s } }

  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const upload = async (who, files, base = '/api/v1/sell-requests') => {
    const m = multipart(files)
    return app.inject({ method: 'POST', url: `${base}/media`, headers: auth(who.token, m.headers), payload: m.payload })
  }
  const uploadOk = async (who, files) => {
    const res = await upload(who, files)
    expect(res.statusCode, res.body).toBe(201)
    return res.json().data.files.map((f) => f.media)
  }
  const newBody = (extra = {}) => ({ type: 'SELL_TO_AB', model: 'iPhone 13', variant: '256GB', color: 'Blue', imei: luhn(uniq14()), qa, description: 'evidence test', ...extra })
  const create = async (who, extra = {}) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/sell-requests', headers: auth(who.token), payload: newBody(extra) })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().data
  }
  const setSettings = (cols) => q(`UPDATE sell_settings SET ${Object.entries(cols).map(([k, v]) => `${k} = ${v}`).join(', ')} WHERE id = TRUE`)
  const fileCount = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).length : 0)

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
      PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'),
    })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Cust One')
    T.other = await mkToken('CUSTOMER', 'Cust Two')
    for (const k of ['vendA', 'vendB']) {
      const n = rand()
      const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Vendor ${k}`, `ev-${n}`, `e${n}@x.test`, `7${n}`])
      T[k] = await mkToken('CUSTOMER', `User ${k}`)
      T[k].vendorId = v.rows[0].id
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[k].vendorId, T[k].id])
    }
  }, 60000)
  afterAll(async () => {
    await setSettings({ max_images: 8, max_videos: 2, max_image_mb: 12, max_video_mb: 100, qc_required_for_approval: false }).catch(() => {})
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ── uploads ───────────────────────────────────────────────────────────
  it('requires authentication to upload', async () => {
    const m = multipart([{ name: 'a.png', type: 'image/png', data: PNG }])
    const res = await app.inject({ method: 'POST', url: '/api/v1/sell-requests/media', headers: m.headers, payload: m.payload })
    expect(res.statusCode).toBe(401)
  })

  it('accepts JPEG, PNG and WebP photos, ignoring the declared type and extension', async () => {
    const out = await uploadOk(T.cust, [
      { name: 'front.jpg', type: 'image/jpeg', data: jpeg() },
      { name: 'back.bin', type: 'application/octet-stream', data: PNG },   // wrong label, real PNG
      { name: 'side.webp', type: 'image/webp', data: webp() },
    ])
    expect(out.map((m) => m.mimeType).sort()).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    expect(out.every((m) => m.mediaType === 'IMAGE' && !m.attached)).toBe(true)
  })

  it('accepts an MP4 and a MOV QC video, and a mix of photos and video in one request', async () => {
    const out = await uploadOk(T.cust, [
      { name: 'qc.mp4', type: 'video/mp4', data: mp4() },
      { name: 'p.jpg', type: 'image/jpeg', data: jpeg() },
      { name: 'qc.mov', type: 'video/quicktime', data: mov() },
    ])
    expect(out.filter((m) => m.mediaType === 'VIDEO').map((m) => m.mimeType).sort()).toEqual(['video/mp4', 'video/quicktime'])
    expect(out.filter((m) => m.mediaType === 'IMAGE')).toHaveLength(1)
  })

  it('rejects files whose real content is not an allowed image/video, and stores nothing', async () => {
    const before = fileCount(process.env.PRIVATE_UPLOAD_DIR)
    const res = await upload(T.cust, [
      { name: 'x.png', type: 'image/png', data: html },                      // HTML pretending to be a PNG
      { name: 'x.exe', type: 'application/x-msdownload', data: Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(200)]) },
      { name: 'x.heic', type: 'image/heic', data: heic() },
      { name: 'empty.jpg', type: 'image/jpeg', data: Buffer.alloc(0) },
    ])
    expect(res.statusCode).toBe(422)
    const files = res.json().data.files
    expect(files.every((f) => f.ok === false)).toBe(true)
    expect(files.slice(0, 3).map((f) => f.code)).toEqual(['UNSUPPORTED_MEDIA', 'UNSUPPORTED_MEDIA', 'UNSUPPORTED_MEDIA'])
    expect(files[3].code).toBe('EMPTY')
    expect(files[2].message).toMatch(/HEIC/i)
    expect(fileCount(process.env.PRIVATE_UPLOAD_DIR)).toBe(before)
  })

  it('a bad file does not discard the good ones (207 partial success)', async () => {
    const res = await upload(T.cust, [{ name: 'ok.jpg', type: 'image/jpeg', data: jpeg() }, { name: 'bad.png', type: 'image/png', data: html }])
    expect(res.statusCode).toBe(207)
    const f = res.json().data.files
    expect(f[0].ok).toBe(true)
    expect(f[1].ok).toBe(false)
  })

  it('enforces the admin-configured photo and video size limits (413), then accepts after they are raised', async () => {
    await setSettings({ max_image_mb: 1, max_video_mb: 5 })
    const bigPhoto = await upload(T.cust, [{ name: 'big.jpg', type: 'image/jpeg', data: jpeg(1_500_000) }])
    expect(bigPhoto.statusCode).toBe(413)
    expect(bigPhoto.json().data.files[0].code).toBe('TOO_LARGE')
    const bigVideo = await upload(T.cust, [{ name: 'big.mp4', type: 'video/mp4', data: mp4(5_500_000) }])
    expect(bigVideo.statusCode).toBe(413)
    // a photo that is fine for photos but would be too big for a video limit is still accepted
    expect((await upload(T.cust, [{ name: 'ok.jpg', type: 'image/jpeg', data: jpeg(900_000) }])).statusCode).toBe(201)
    await setSettings({ max_image_mb: 12, max_video_mb: 100 })
    expect((await upload(T.cust, [{ name: 'big.jpg', type: 'image/jpeg', data: jpeg(1_500_000) }])).statusCode).toBe(201)
  })

  it('storage failure is reported as retryable, leaves no temp files, and a retry succeeds', async () => {
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))
    const res = await upload(T.cust, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }])
    expect(res.statusCode).toBe(503)
    expect(res.json().data.files[0]).toMatchObject({ ok: false, code: 'STORAGE_FAILED' })
    spy.mockRestore()
    const tmpDir = path.join(process.env.PRIVATE_UPLOAD_DIR, 'sell-evidence', '_tmp')
    expect(fileCount(tmpDir)).toBe(0)
    expect((await upload(T.cust, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }])).statusCode).toBe(201)
  })

  it('an interrupted upload leaves nothing behind and does not create a row', async () => {
    const { saveEvidence, EvidenceError } = await import('../../src/modules/sell-requests/evidence-storage.js')
    const half = new Readable({ read() {} })
    half.push(jpeg(5000))
    setTimeout(() => half.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 100)
    await expect(saveEvidence({ file: half }, { limitsFor: () => 1e7 })).rejects.toMatchObject({ code: 'UPLOAD_INTERRUPTED' })
    expect(fileCount(path.join(process.env.PRIVATE_UPLOAD_DIR, 'sell-evidence', '_tmp'))).toBe(0)
    expect(EvidenceError).toBeTruthy()
  })

  // ── attach + display after refresh ────────────────────────────────────
  let req, photos, video
  it('submits a request with photos and a QC video; evidence is returned again after a fresh read', async () => {
    photos = await uploadOk(T.cust, [{ name: 'front.jpg', type: 'image/jpeg', data: jpeg() }, { name: 'back.png', type: 'image/png', data: PNG }])
    video = (await uploadOk(T.cust, [{ name: 'qc.mp4', type: 'video/mp4', data: mp4(200_000) }]))[0]
    req = await create(T.cust, { mediaIds: [...photos.map((p) => p.id), video.id] })
    expect(req.imageCount).toBe(2)
    expect(req.videoCount).toBe(1)
    expect(req.qc.status).toBe('EVIDENCE_UPLOADED')

    // "refresh": a brand-new read by both the customer and an admin
    const mine = (await app.inject({ method: 'GET', url: `/api/v1/sell-requests/${req.id}`, headers: auth(T.cust.token) })).json().data
    const adm = (await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/${req.id}`, headers: auth(T.admin.token) })).json().data
    for (const r of [mine, adm]) {
      expect(r.media).toHaveLength(3)
      expect(r.media.filter((m) => m.mediaType === 'VIDEO')).toHaveLength(1)
      expect(r.media.every((m) => m.attached && m.stage === 'CUSTOMER_SUBMISSION')).toBe(true)
    }
    expect(adm.timeline.some((t) => /photos? and 1 video added/.test(t.label))).toBe(true)
  })

  it('serves the stored bytes through the signed link (with Range), and refuses bad or expired links', async () => {
    const adm = (await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/${req.id}`, headers: auth(T.admin.token) })).json().data
    const v = adm.media.find((m) => m.mediaType === 'VIDEO')
    const full = await app.inject({ method: 'GET', url: v.url })
    expect(full.statusCode).toBe(200)
    expect(full.headers['content-type']).toBe('video/mp4')
    expect(full.headers['x-content-type-options']).toBe('nosniff')
    expect(crypto.createHash('sha256').update(full.rawPayload).digest('hex')).toBe(v.checksum)
    expect(full.rawPayload.length).toBe(v.size)

    const part = await app.inject({ method: 'GET', url: v.url, headers: { range: 'bytes=10-99' } })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 10-99/${v.size}`)
    expect(part.rawPayload.length).toBe(90)
    expect((await app.inject({ method: 'GET', url: v.url, headers: { range: `bytes=${v.size + 5}-` } })).statusCode).toBe(416)

    const [pathname, qs] = v.url.split('?')
    const sp = new URLSearchParams(qs)
    expect((await app.inject({ method: 'GET', url: `${pathname}?exp=${sp.get('exp')}&sig=${sp.get('sig').slice(0, -2)}xx` })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: pathname })).statusCode).toBe(403)
    // a valid signature for ANOTHER file id must not open this one
    const other = adm.media.find((m) => m.id !== v.id)
    const osp = new URLSearchParams(other.url.split('?')[1])
    expect((await app.inject({ method: 'GET', url: `${pathname}?exp=${osp.get('exp')}&sig=${osp.get('sig')}` })).statusCode).toBe(403)
    // expired
    const { signEvidence } = await import('../../src/modules/sell-requests/evidence-storage.js')
    const old = signEvidence(v.id, -10)
    expect((await app.inject({ method: 'GET', url: `${pathname}?exp=${old.exp}&sig=${old.sig}` })).statusCode).toBe(403)
  })

  it('a missing file on disk is a clean 404, not a crash', async () => {
    const { rows } = await q(`SELECT id, storage_key FROM sell_request_media WHERE entity_id = $1 AND media_type='IMAGE' LIMIT 1`, [req.id])
    const { evidencePath, signEvidence } = await import('../../src/modules/sell-requests/evidence-storage.js')
    const abs = evidencePath(rows[0].storage_key)
    const keep = fs.readFileSync(abs)
    fs.unlinkSync(abs)
    const s = signEvidence(rows[0].id)
    const res = await app.inject({ method: 'GET', url: `/api/v1/media/sell-evidence/${rows[0].id}?exp=${s.exp}&sig=${s.sig}` })
    expect(res.statusCode).toBe(404)
    fs.writeFileSync(abs, keep)
  })

  // ── isolation ─────────────────────────────────────────────────────────
  it('another customer cannot read, attach, or fetch links for someone else’s evidence', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/v1/sell-requests/${req.id}`, headers: auth(T.other.token) })).statusCode).toBe(404)
    const mine = (await app.inject({ method: 'GET', url: `/api/v1/sell-requests/${req.id}`, headers: auth(T.cust.token) })).json().data
    expect((await app.inject({ method: 'GET', url: `/api/v1/sell-requests/media/${mine.media[0].id}/link`, headers: auth(T.other.token) })).statusCode).toBe(404)
    // other user's upload cannot be claimed by me, and mine cannot be claimed by them
    const theirs = await uploadOk(T.other, [{ name: 'o.jpg', type: 'image/jpeg', data: jpeg() }])
    const steal = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${req.id}/media`, headers: auth(T.cust.token), payload: { mediaIds: [theirs[0].id] } })
    expect(steal.statusCode).toBe(404)
    const intrude = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${req.id}/media`, headers: auth(T.other.token), payload: { mediaIds: [theirs[0].id] } })
    expect(intrude.statusCode).toBe(404)
    // attached evidence cannot be discarded or re-attached
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/sell-requests/media/${mine.media[0].id}`, headers: auth(T.cust.token) })).statusCode).toBe(404)
    const again = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${req.id}/media`, headers: auth(T.cust.token), payload: { mediaIds: [mine.media[0].id] } })
    expect(again.statusCode).toBe(409)
    // the SELL section cannot be used for EXCHANGE evidence endpoints
    expect((await app.inject({ method: 'GET', url: `/api/v1/exchange-requests/${req.id}`, headers: auth(T.cust.token) })).statusCode).toBe(404)
  })

  it('customers cannot use the manage evidence/QC surface; vendors only see/add for what they are assigned', async () => {
    for (const [method, url] of [['POST', `/api/v1/manage/sell-requests/${req.id}/qc/start`], ['POST', `/api/v1/manage/sell-requests/${req.id}/qc/decision`], ['GET', `/api/v1/manage/sell-requests/${req.id}/qc`]]) {
      expect((await app.inject({ method, url, headers: auth(T.cust.token), payload: {} })).statusCode, `${method} ${url}`).toBe(403)
    }
    // vendors can never run QC decisions
    expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${req.id}/qc/decision`, headers: auth(T.vendA.token), payload: { result: 'PASSED' } })).statusCode).toBe(403)

    // vendor A is assigned; vendor B is not
    await q(`UPDATE sell_requests SET assigned_vendor_id = $2, status = 'IN_PROGRESS' WHERE id = $1`, [req.id, T.vendA.vendorId])
    const pic = await uploadOk(T.vendA, [{ name: 'pickup.jpg', type: 'image/jpeg', data: jpeg() }])
    const ok = await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${req.id}/media`, headers: auth(T.vendA.token), payload: { mediaIds: [pic[0].id], stage: 'PICKUP_INSPECTION' } })
    expect(ok.statusCode, ok.body).toBe(200)
    const wrongStage = await uploadOk(T.vendA, [{ name: 'x.jpg', type: 'image/jpeg', data: jpeg() }])
    expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${req.id}/media`, headers: auth(T.vendA.token), payload: { mediaIds: [wrongStage[0].id], stage: 'FINAL_QC' } })).statusCode).toBe(403)
    const bPic = await uploadOk(T.vendB, [{ name: 'b.jpg', type: 'image/jpeg', data: jpeg() }])
    expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${req.id}/media`, headers: auth(T.vendB.token), payload: { mediaIds: [bPic[0].id], stage: 'PICKUP_INSPECTION' } })).statusCode).toBe(404)
    // vendor B cannot see a request assigned to vendor A, nor mint a link to its files
    expect((await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/${req.id}`, headers: auth(T.vendB.token) })).statusCode).toBe(404)
    const fileId = (await q(`SELECT id FROM sell_request_media WHERE entity_id = $1 LIMIT 1`, [req.id])).rows[0].id
    expect((await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/media/${fileId}/link`, headers: auth(T.vendB.token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/media/${fileId}/link`, headers: auth(T.vendA.token) })).statusCode).toBe(200)
  })

  it('enforces the configured per-stage photo/video counts', async () => {
    await setSettings({ max_videos: 1 })
    const c = await create(T.other)
    const vids = await uploadOk(T.other, [{ name: '1.mp4', type: 'video/mp4', data: mp4() }, { name: '2.mp4', type: 'video/mp4', data: mp4() }])
    const res = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${c.id}/media`, headers: auth(T.other.token), payload: { mediaIds: vids.map((v) => v.id) } })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('TOO_MANY_VIDEOS')
    await setSettings({ max_videos: 2 })
    const ok = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${c.id}/media`, headers: auth(T.other.token), payload: { mediaIds: vids.map((v) => v.id) } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().data.videoCount).toBe(2)
  })

  it('unattached uploads can be discarded by the owner and are swept after 24 hours', async () => {
    const [m] = await uploadOk(T.cust, [{ name: 'tmp.jpg', type: 'image/jpeg', data: jpeg() }])
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/sell-requests/media/${m.id}`, headers: auth(T.cust.token) })).statusCode).toBe(200)
    const [o] = await uploadOk(T.cust, [{ name: 'old.jpg', type: 'image/jpeg', data: jpeg() }])
    await q(`UPDATE sell_request_media SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [o.id])
    const { purgeOrphanMedia } = await import('../../src/modules/sell-requests/evidence.service.js')
    expect(await purgeOrphanMedia()).toBeGreaterThanOrEqual(1)
    expect((await q(`SELECT 1 FROM sell_request_media WHERE id = $1`, [o.id])).rows).toHaveLength(0)
    // attached evidence is never swept
    expect((await q(`SELECT COUNT(*)::int AS n FROM sell_request_media WHERE entity_id = $1`, [req.id])).rows[0].n).toBeGreaterThan(0)
  })

  it('attached evidence is immutable at the database level', async () => {
    await expect(q(`DELETE FROM sell_request_media WHERE entity_id = $1`, [req.id])).rejects.toThrow(/cannot be deleted/)
    await expect(q(`UPDATE sell_request_media SET checksum = repeat('0',64) WHERE entity_id = $1`, [req.id])).rejects.toThrow(/immutable/)
    await expect(q(`UPDATE sell_request_media SET evidence_stage = 'FINAL_QC' WHERE entity_id = $1`, [req.id])).rejects.toThrow(/immutable/)
  })

  // ── historical requests ───────────────────────────────────────────────
  it('a historical request (legacy images, no media, no QC row) still loads and works', async () => {
    const c = await create(T.other, { images: [] })
    await q(`DELETE FROM sell_request_qc WHERE request_id = $1`, [c.id])
    await q(`UPDATE sell_requests SET images = '["http://localhost:4500/uploads/2026-01/legacy.jpg"]'::jsonb WHERE id = $1`, [c.id])
    const adm = (await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/${c.id}`, headers: auth(T.admin.token) })).json().data
    expect(adm.images).toEqual(['http://localhost:4500/uploads/2026-01/legacy.jpg'])
    expect(adm.imageCount).toBe(1)
    expect(adm.videoCount).toBe(0)
    expect(adm.media).toEqual([])
    expect(adm.qc.status).toBe('NOT_STARTED')
    const list = (await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests?limit=50', headers: auth(T.admin.token) })).json().data
    expect(list.items.find((i) => i.id === c.id).imageCount).toBe(1)
  })

  // ── request-level QC ──────────────────────────────────────────────────
  describe('request QC workflow', () => {
    const qcUrl = (id, a) => `/api/v1/manage/sell-requests/${id}/qc/${a}`
    const post = (id, a, body = {}, who = T.admin) => app.inject({ method: 'POST', url: qcUrl(id, a), headers: auth(who.token), payload: body })
    const findings = { physicalCondition: 'GOOD', screenCondition: 'MINOR_SCRATCHES', imeiVerified: true, batteryHealth: 86, functionality: { powersOn: true, touch: true, camera: true }, remarks: 'Light wear' }
    let r

    it('cannot start inspection without evidence, then can once evidence exists', async () => {
      r = await create(T.cust)
      expect(r.qc.status).toBe('AWAITING_EVIDENCE')
      const res = await post(r.id, 'start')
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('NO_EVIDENCE')
      const m = await uploadOk(T.cust, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }, { name: 'v.mp4', type: 'video/mp4', data: mp4() }])
      const add = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${r.id}/media`, headers: auth(T.cust.token), payload: { mediaIds: m.map((x) => x.id) } })
      expect(add.json().data.qc.status).toBe('EVIDENCE_UPLOADED')
    })

    it('rejects invalid status jumps (server enforced)', async () => {
      for (const body of [{ result: 'PASSED' }, { result: 'FAILED', note: 'x' }]) {
        const res = await post(r.id, 'decision', body)
        expect(res.statusCode, JSON.stringify(body)).toBe(409)
        expect(res.json().code).toBe('INVALID_QC_STATE')
      }
      expect((await post(r.id, 'inspection', findings)).statusCode).toBe(409) // not started yet
      expect((await post(r.id, 'reopen', { reason: 'x' })).statusCode).toBe(409)
    })

    it('inspection → decision, with validation and the IMEI rule', async () => {
      expect((await post(r.id, 'start')).statusCode).toBe(200)
      expect((await post(r.id, 'start')).statusCode).toBe(409)                       // already started
      expect((await post(r.id, 'inspection', { ...findings, physicalCondition: 'MINT' })).statusCode).toBe(422)
      expect((await post(r.id, 'inspection', { ...findings, batteryHealth: 140 })).statusCode).toBe(422)
      expect((await post(r.id, 'inspection', { ...findings, functionality: { 'bad key!': true } })).statusCode).toBe(422)
      // an IMEI that does not match the request cannot pass, even if the box was ticked
      const mismatch = await post(r.id, 'inspection', { ...findings, imeiVerified: true, imeiObserved: '111111111111111' })
      expect(mismatch.statusCode).toBe(200)
      expect(mismatch.json().data.qc.imeiVerified).toBe(false)
      const pass = await post(r.id, 'decision', { result: 'PASSED', finalValuation: 20000 })
      expect(pass.statusCode).toBe(409)
      expect(pass.json().code).toBe('IMEI_MISMATCH')
      // recheck needs a reason; with one it loops back to inspection
      expect((await post(r.id, 'decision', { result: 'RECHECK' })).statusCode).toBe(422)
      expect((await post(r.id, 'decision', { result: 'RECHECK', note: 'IMEI does not match, re-inspect' })).statusCode).toBe(200)
      expect((await post(r.id, 'start')).statusCode).toBe(200)
      expect((await post(r.id, 'inspection', findings)).statusCode).toBe(200)
    })

    it('PASSED records the final valuation and asks the customer; the customer decides', async () => {
      expect((await post(r.id, 'decision', { result: 'PASSED', finalValuation: -5 })).statusCode).toBe(422)
      const pass = await post(r.id, 'decision', { result: 'PASSED', finalValuation: 21500 })
      expect(pass.statusCode, pass.body).toBe(200)
      expect(pass.json().data.qc).toMatchObject({ status: 'PASSED', finalValuation: 21500, customerDecision: 'PENDING' })

      // customers see the outcome, not the inspector identity or history
      const mine = (await app.inject({ method: 'GET', url: `/api/v1/sell-requests/${r.id}`, headers: auth(T.cust.token) })).json().data
      expect(mine.qc).toMatchObject({ status: 'PASSED', finalValuation: 21500, customerDecision: 'PENDING' })
      expect(mine.qc.history).toBeUndefined()
      expect(mine.qc.inspectorId).toBeUndefined()

      expect((await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${r.id}/qc/decision`, headers: auth(T.other.token), payload: { decision: 'ACCEPT' } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${r.id}/qc/decision`, headers: auth(T.cust.token), payload: { decision: 'MAYBE' } })).statusCode).toBe(422)
      const acc = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${r.id}/qc/decision`, headers: auth(T.cust.token), payload: { decision: 'ACCEPT' } })
      expect(acc.statusCode, acc.body).toBe(200)
      expect(acc.json().data.qc.customerDecision).toBe('ACCEPTED')
      // cannot decide twice, cannot reopen after acceptance
      expect((await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${r.id}/qc/decision`, headers: auth(T.cust.token), payload: { decision: 'DECLINE' } })).statusCode).toBe(409)
      expect((await post(r.id, 'reopen', { reason: 'changed mind' })).statusCode).toBe(409)
    })

    it('records an append-only history with actors', async () => {
      const qc = (await app.inject({ method: 'GET', url: qcUrl(r.id, '').replace(/\/$/, ''), headers: auth(T.admin.token) })).json().data
      const actions = qc.history.map((h) => h.action)
      expect(actions).toEqual(expect.arrayContaining(['QC_OPENED', 'EVIDENCE_UPLOADED', 'INSPECTION_STARTED', 'INSPECTION_SUBMITTED', 'QC_RECHECK', 'QC_PASSED', 'CUSTOMER_ACCEPTED']))
      expect(qc.history.every((h) => h.actorRole)).toBe(true)
      await expect(q(`UPDATE sell_request_qc_events SET note = 'tampered' WHERE request_id = $1`, [r.id])).rejects.toThrow(/append-only/)
    })

    it('QC gate is off by default (existing approval flow unchanged) and enforceable when switched on', async () => {
      const c = await create(T.other)
      await q(`UPDATE sell_requests SET assigned_vendor_id = $2, status = 'IN_PROGRESS', final_price = 20000 WHERE id = $1`, [c.id, T.vendA.vendorId])
      // gate off → existing behaviour: approves without QC
      const free = await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${c.id}/approve`, headers: auth(T.admin.token), payload: {} })
      expect(free.statusCode, free.body).toBe(200)

      await setSettings({ qc_required_for_approval: true })
      const g = await create(T.other)
      await q(`UPDATE sell_requests SET assigned_vendor_id = $2, status = 'IN_PROGRESS', final_price = 20000 WHERE id = $1`, [g.id, T.vendA.vendorId])
      const blocked = await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${g.id}/approve`, headers: auth(T.admin.token), payload: {} })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().code).toBe('QC_NOT_PASSED')

      // run it through QC → approve OK, but completion still needs the customer's acceptance
      const m = await uploadOk(T.other, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }])
      await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${g.id}/media`, headers: auth(T.other.token), payload: { mediaIds: [m[0].id] } })
      await post(g.id, 'start'); await post(g.id, 'inspection', findings); await post(g.id, 'decision', { result: 'PASSED', finalValuation: 19000 })
      expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${g.id}/approve`, headers: auth(T.admin.token), payload: {} })).statusCode).toBe(200)
      const early = await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${g.id}/complete`, headers: auth(T.admin.token), payload: {} })
      expect(early.statusCode).toBe(409)
      expect(early.json().code).toBe('CUSTOMER_NOT_ACCEPTED')
      await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${g.id}/qc/decision`, headers: auth(T.other.token), payload: { decision: 'ACCEPT' } })
      expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${g.id}/complete`, headers: auth(T.admin.token), payload: {} })).statusCode).toBe(200)

      // evidence + history survive every status change
      const after = (await app.inject({ method: 'GET', url: `/api/v1/manage/sell-requests/${g.id}`, headers: auth(T.admin.token) })).json().data
      expect(after.status).toBe('COMPLETED')
      expect(after.media).toHaveLength(1)
      expect(after.qc.history.length).toBeGreaterThan(4)
      await setSettings({ qc_required_for_approval: false })
    })

    it('a customer declining the final valuation cancels the request', async () => {
      const c = await create(T.other)
      const m = await uploadOk(T.other, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }])
      await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${c.id}/media`, headers: auth(T.other.token), payload: { mediaIds: [m[0].id] } })
      await post(c.id, 'start'); await post(c.id, 'inspection', findings); await post(c.id, 'decision', { result: 'PASSED' })
      const dec = await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${c.id}/qc/decision`, headers: auth(T.other.token), payload: { decision: 'DECLINE' } })
      expect(dec.statusCode, dec.body).toBe(200)
      const row = (await q(`SELECT status FROM sell_requests WHERE id = $1`, [c.id])).rows[0]
      expect(row.status).toBe('CANCELLED')
      // QC can no longer change on a closed request
      expect((await post(c.id, 'reopen', { reason: 'x' })).statusCode).toBe(409)
    })

    it('FAILED needs a reason and can be reopened with one; staff can verify or reject evidence', async () => {
      const c = await create(T.cust)
      const m = await uploadOk(T.cust, [{ name: 'a.jpg', type: 'image/jpeg', data: jpeg() }])
      await app.inject({ method: 'POST', url: `/api/v1/sell-requests/${c.id}/media`, headers: auth(T.cust.token), payload: { mediaIds: [m[0].id] } })
      await post(c.id, 'start'); await post(c.id, 'inspection', findings)
      expect((await post(c.id, 'decision', { result: 'FAILED' })).statusCode).toBe(422)
      expect((await post(c.id, 'decision', { result: 'FAILED', note: 'Water damage' })).statusCode).toBe(200)
      expect((await post(c.id, 'reopen', {})).statusCode).toBe(422)
      expect((await post(c.id, 'reopen', { reason: 'Customer supplied proof' })).json().data.qc.status).toBe('RECHECK')

      const ver = (id, body) => app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/media/${id}/verify`, headers: auth(T.admin.token), payload: body })
      expect((await ver(m[0].id, { status: 'REJECTED' })).statusCode).toBe(422)
      const okv = await ver(m[0].id, { status: 'VERIFIED' })
      expect(okv.json().data.verification.status).toBe('VERIFIED')
      expect((await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/media/${m[0].id}/verify`, headers: auth(T.cust.token), payload: { status: 'VERIFIED' } })).statusCode).toBe(403)
    })
  })

  it('evidence settings are validated and returned to the dashboard', async () => {
    const put = (body) => app.inject({ method: 'PUT', url: '/api/v1/manage/sell-requests/settings', headers: auth(T.admin.token), payload: body })
    expect((await put({ maxVideos: 99 })).statusCode).toBe(422)
    expect((await put({ maxVideoMb: 1 })).statusCode).toBe(422)
    expect((await put({ maxImages: 25 })).statusCode).toBe(422)
    const ok = await put({ maxVideos: 3, maxImageMb: 10, maxVideoMb: 150 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().data).toMatchObject({ maxVideos: 3, maxImageMb: 10, maxVideoMb: 150, qcRequiredForApproval: false })
    await setSettings({ max_videos: 2, max_image_mb: 12, max_video_mb: 100 })
  })
})
