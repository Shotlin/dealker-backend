/**
 * Sell/Exchange request evidence: photos and QC video.
 *
 * Two steps, on purpose:
 *   1. upload  — file is streamed to private storage and recorded as an *unclaimed* row owned by the uploader.
 *   2. attach  — the owner (or authorised staff) attaches uploaded ids to a request, in one transaction.
 *
 * This lets the app show per-file progress/retry, and means a failed upload can never half-create a request.
 * Unclaimed uploads are swept after 24 h. Once attached, evidence is immutable (DB trigger).
 *
 * @module modules/sell-requests/evidence.service
 */
import { query } from '../../config/database.js'
import { SellError, addEvent, getSettings, lock, tx } from './sell-requests.service.js'
import { EvidenceError, removeEvidence, saveEvidence, signEvidence } from './evidence-storage.js'

export const STAGES = ['CUSTOMER_SUBMISSION', 'PICKUP_INSPECTION', 'TECHNICIAN_QC', 'FINAL_QC', 'DISPUTE']
const CUSTOMER_STAGES = ['CUSTOMER_SUBMISSION', 'DISPUTE']
const VENDOR_STAGES = ['PICKUP_INSPECTION']
const TERMINAL = ['REJECTED', 'CANCELLED', 'COMPLETED']
const MAX_PENDING_PER_USER = 30
const MAX_ATTACH_BATCH = 30
const ORPHAN_TTL_HOURS = 24

const STAGE_LABEL = {
  CUSTOMER_SUBMISSION: 'customer submission',
  PICKUP_INSPECTION: 'pickup inspection',
  TECHNICIAN_QC: 'technician QC',
  FINAL_QC: 'final QC',
  DISPUTE: 'dispute',
}

export function serializeMedia(m) {
  const { exp, sig } = signEvidence(m.id)
  return {
    id: m.id,
    mediaType: m.media_type,
    stage: m.evidence_stage,
    filename: m.original_filename,
    mimeType: m.mime_type,
    size: Number(m.byte_size),
    checksum: m.checksum,
    uploadedAt: m.created_at.toISOString(),
    uploadedByRole: m.uploaded_by_role,
    attached: !!m.entity_id,
    verification: { status: m.verification_status, note: m.verification_note || undefined, at: m.verified_at?.toISOString() ?? null },
    // Path only — clients resolve it against the API origin. Valid for 30 minutes; re-fetch the request for a fresh one.
    url: `/api/v1/media/sell-evidence/${m.id}?exp=${exp}&sig=${sig}`,
  }
}

export async function listMedia(requestId, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run(
    `SELECT * FROM sell_request_media WHERE entity_id = $1 ORDER BY created_at, id`, [requestId]
  )
  return rows.map(serializeMedia)
}

export async function mediaCounts(requestIds) {
  if (!requestIds.length) return new Map()
  const { rows } = await query(
    `SELECT entity_id, media_type, COUNT(*)::int AS n FROM sell_request_media
      WHERE entity_id = ANY($1) GROUP BY entity_id, media_type`, [requestIds]
  )
  const out = new Map()
  for (const r of rows) {
    const cur = out.get(r.entity_id) || { images: 0, videos: 0 }
    if (r.media_type === 'IMAGE') cur.images = r.n; else cur.videos = r.n
    out.set(r.entity_id, cur)
  }
  return out
}

/** The limits an admin configured, in bytes/counts. */
export async function evidenceLimits(client = null) {
  const s = await getSettings(client)
  return { maxImages: s.max_images, maxVideos: s.max_videos, imageBytes: s.max_image_mb * 1048576, videoBytes: s.max_video_mb * 1048576 }
}

// ── Step 1: upload ──────────────────────────────────────────────────────

/**
 * Stream every file part of a multipart request to storage. Returns one result per file, so a bad
 * file does not discard the good ones (each reports its own error and can be retried on its own).
 */
export async function uploadParts(actor, parts) {
  const limits = await evidenceLimits()
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM sell_request_media
      WHERE uploaded_by = $1 AND entity_id IS NULL AND created_at > NOW() - INTERVAL '${ORPHAN_TTL_HOURS} hours'`, [actor.userId]
  )
  let pending = rows[0].n
  const results = []
  for await (const part of parts) {
    const filename = String(part.filename || 'upload').replace(/[^\w.\- ()]/g, '_').slice(0, 255)
    try {
      if (pending >= MAX_PENDING_PER_USER) throw new EvidenceError('TOO_MANY_PENDING', 'Too many unattached uploads. Submit your request or remove some files.', 429)
      const saved = await saveEvidence(part, { limitsFor: (kind) => (kind === 'VIDEO' ? limits.videoBytes : limits.imageBytes) })
      try {
        const { rows: ins } = await query(
          `INSERT INTO sell_request_media (media_type, storage_key, original_filename, mime_type, byte_size, checksum, uploaded_by, uploaded_by_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [saved.kind, saved.storageKey, filename, saved.mime, saved.size, saved.checksum, actor.userId, actor.kind]
        )
        pending += 1
        results.push({ ok: true, filename, media: serializeMedia(ins[0]) })
      } catch (dbErr) {
        await removeEvidence(saved.storageKey)
        throw dbErr
      }
    } catch (err) {
      if (err instanceof EvidenceError) {
        results.push({ ok: false, filename, code: err.code, message: err.message, status: err.statusCode })
        // After a truncated/oversize file busboy may still be draining it; discard the rest of that part.
        part.file?.resume?.()
      } else {
        results.push({ ok: false, filename, code: 'STORAGE_FAILED', message: 'The file could not be saved. Please retry.', status: 503 })
        part.file?.resume?.()
      }
    }
  }
  return results
}

/** Remove an upload that has not been attached to a request yet. Owner only. */
export async function discardPending(actor, mediaId) {
  const { rows } = await query(
    `DELETE FROM sell_request_media WHERE id = $1 AND uploaded_by = $2 AND entity_id IS NULL RETURNING storage_key`,
    [mediaId, actor.userId]
  )
  if (!rows[0]) throw new SellError('NOT_FOUND', 'Upload not found, or it is already attached to a request', 404)
  await removeEvidence(rows[0].storage_key)
}

// ── Step 2: attach ──────────────────────────────────────────────────────

/**
 * Attach uploaded files to a request. Runs inside the caller's transaction (client).
 * The caller must already hold the request row lock.
 */
export async function claimMedia(client, request, actor, mediaIds, stage = 'CUSTOMER_SUBMISSION') {
  const ids = [...new Set(Array.isArray(mediaIds) ? mediaIds : [])]
  if (!ids.length) return { added: 0 }
  if (ids.length > MAX_ATTACH_BATCH) throw new SellError('VALIDATION', `Attach at most ${MAX_ATTACH_BATCH} files at a time`, 422)
  if (ids.some((i) => typeof i !== 'string' || !/^[0-9a-f-]{36}$/i.test(i))) throw new SellError('VALIDATION', 'Invalid media id', 422)
  if (!STAGES.includes(stage)) throw new SellError('VALIDATION', 'Unknown evidence stage', 422)

  // Who may add which kind of evidence, and to whose request.
  if (actor.kind === 'CUSTOMER') {
    if (request.user_id !== actor.userId) throw new SellError('NOT_FOUND', 'Request not found', 404)
    if (!CUSTOMER_STAGES.includes(stage)) throw new SellError('FORBIDDEN', 'Customers can only add submission or dispute evidence', 403)
  } else if (actor.kind === 'VENDOR') {
    if (!actor.vendorId || request.assigned_vendor_id !== actor.vendorId) throw new SellError('NOT_FOUND', 'Request not found', 404)
    if (!VENDOR_STAGES.includes(stage)) throw new SellError('FORBIDDEN', 'Vendors can only add pickup inspection evidence', 403)
  }
  if (TERMINAL.includes(request.status) && stage !== 'DISPUTE' && actor.kind !== 'ADMIN') {
    throw new SellError('INVALID_STATE', 'Evidence can no longer be added to a closed request', 409)
  }

  const { rows } = await client.query(`SELECT * FROM sell_request_media WHERE id = ANY($1) FOR UPDATE`, [ids])
  // Same answer for "missing" and "someone else's": never reveal other users' uploads.
  const mine = rows.filter((m) => m.uploaded_by === actor.userId)
  if (mine.length !== ids.length) throw new SellError('NOT_FOUND', 'One or more uploads were not found', 404)
  if (mine.some((m) => m.entity_id)) throw new SellError('ALREADY_ATTACHED', 'One or more files are already attached to a request', 409)

  const limits = await evidenceLimits(client)
  const { rows: have } = await client.query(
    `SELECT media_type, COUNT(*)::int AS n FROM sell_request_media WHERE entity_id = $1 AND evidence_stage = $2 GROUP BY media_type`,
    [request.id, stage]
  )
  const cur = { IMAGE: 0, VIDEO: 0, ...Object.fromEntries(have.map((h) => [h.media_type, h.n])) }
  const add = { IMAGE: mine.filter((m) => m.media_type === 'IMAGE').length, VIDEO: mine.filter((m) => m.media_type === 'VIDEO').length }
  if (cur.IMAGE + add.IMAGE > limits.maxImages) throw new SellError('TOO_MANY_PHOTOS', `At most ${limits.maxImages} photos are allowed for ${STAGE_LABEL[stage]}`, 422)
  if (cur.VIDEO + add.VIDEO > limits.maxVideos) throw new SellError('TOO_MANY_VIDEOS', `At most ${limits.maxVideos} video${limits.maxVideos === 1 ? '' : 's'} allowed for ${STAGE_LABEL[stage]}`, 422)

  await client.query(
    `UPDATE sell_request_media SET entity_id = $2, claimed_at = NOW(), evidence_stage = $3 WHERE id = ANY($1)`,
    [ids, request.id, stage]
  )
  const bits = []
  if (add.IMAGE) bits.push(`${add.IMAGE} photo${add.IMAGE === 1 ? '' : 's'}`)
  if (add.VIDEO) bits.push(`${add.VIDEO} video${add.VIDEO === 1 ? '' : 's'}`)
  await addEvent(client, request.id, 'EVIDENCE_ADDED', `${bits.join(' and ')} added (${STAGE_LABEL[stage]})`, actor, { stage, mediaIds: ids })

  // Customer evidence moves the QC process forward.
  const { rows: qc } = await client.query(`SELECT status FROM sell_request_qc WHERE request_id = $1 FOR UPDATE`, [request.id])
  if (qc[0]?.status === 'AWAITING_EVIDENCE' && stage === 'CUSTOMER_SUBMISSION') {
    await client.query(`UPDATE sell_request_qc SET status = 'EVIDENCE_UPLOADED', updated_at = NOW() WHERE request_id = $1`, [request.id])
    await client.query(
      `INSERT INTO sell_request_qc_events (request_id, from_status, to_status, action, actor_id, actor_role) VALUES ($1,'AWAITING_EVIDENCE','EVIDENCE_UPLOADED','EVIDENCE_UPLOADED',$2,$3)`,
      [request.id, actor.userId, actor.kind]
    )
  }
  return { added: ids.length }
}

/** Attach to an existing request (customer on their own, assigned vendor, or staff). */
export const attachToRequest = (actor, requestId, mediaIds, stage) =>
  tx(async (client) => {
    const r = await lock(client, requestId, actor)
    return claimMedia(client, r, actor, mediaIds, stage)
  })

// ── Verification & reads ────────────────────────────────────────────────

export async function verifyMedia(actor, mediaId, status, note) {
  if (!['VERIFIED', 'REJECTED', 'PENDING'].includes(status)) throw new SellError('VALIDATION', 'Invalid verification status', 422)
  const n = String(note ?? '').trim().slice(0, 500)
  if (status === 'REJECTED' && !n) throw new SellError('VALIDATION', 'A reason is required when rejecting evidence', 422)
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*, r.kind FROM sell_request_media m JOIN sell_requests r ON r.id = m.entity_id WHERE m.id = $1 FOR UPDATE OF m`, [mediaId]
    )
    if (!rows[0] || rows[0].kind !== actor.scopeKind) throw new SellError('NOT_FOUND', 'Evidence not found', 404)
    await client.query(
      `UPDATE sell_request_media SET verification_status = $2, verification_note = $3, verified_by = $4, verified_at = NOW() WHERE id = $1`,
      [mediaId, status, n || null, actor.userId]
    )
    await addEvent(client, rows[0].entity_id, 'EVIDENCE_REVIEWED', `Evidence ${status.toLowerCase()}`, actor, { mediaId, status, note: n || undefined })
    const { rows: out } = await client.query(`SELECT * FROM sell_request_media WHERE id = $1`, [mediaId])
    return serializeMedia(out[0])
  })
}

/** Load one file for the signed-URL endpoint. Returns null when it should 404. */
export async function getStoredMedia(id) {
  const { rows } = await query(`SELECT id, storage_key, mime_type, byte_size, original_filename, checksum, entity_id FROM sell_request_media WHERE id = $1`, [id])
  return rows[0] || null
}

/** Authorise a viewer for one file, then mint a fresh signed link (used by "open in new tab"). */
export async function signedLinkFor(actor, mediaId, fetchRequest) {
  const { rows } = await query(`SELECT * FROM sell_request_media WHERE id = $1`, [mediaId])
  const m = rows[0]
  if (!m) throw new SellError('NOT_FOUND', 'Evidence not found', 404)
  if (!m.entity_id) {
    if (m.uploaded_by !== actor.userId) throw new SellError('NOT_FOUND', 'Evidence not found', 404)
  } else {
    await fetchRequest(m.entity_id) // throws NOT_FOUND unless the actor can see the request
  }
  return serializeMedia(m)
}

/** Delete never-attached uploads older than the TTL (files too). Safe to run repeatedly. */
export async function purgeOrphanMedia(olderThanHours = ORPHAN_TTL_HOURS) {
  const { rows } = await query(
    `DELETE FROM sell_request_media WHERE entity_id IS NULL AND created_at < NOW() - ($1 || ' hours')::interval RETURNING storage_key`,
    [String(olderThanHours)]
  )
  for (const r of rows) await removeEvidence(r.storage_key)
  return rows.length
}
