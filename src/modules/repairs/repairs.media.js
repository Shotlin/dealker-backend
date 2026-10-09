/**
 * Repair evidence (customer photos/videos, intake, diagnosis, progress, final QC, delivery).
 * Same private storage, content sniffing and signed links as sell-request evidence; own table and rules.
 * Two steps: upload (unattached, owned by the uploader) → attach to a request in a transaction.
 */
import { query } from '../../config/database.js'
import { EvidenceError, removeEvidence, saveEvidence, signEvidence } from '../sell-requests/evidence-storage.js'
import { RepairError, addEvent, getSettings, lock, tx } from './repairs.service.js'

export const REPAIR_STAGES = ['CUSTOMER_SUBMISSION', 'INTAKE', 'DIAGNOSIS', 'REPAIR_PROGRESS', 'FINAL_QC', 'DELIVERY', 'DISPUTE']
const CUSTOMER_STAGES = ['CUSTOMER_SUBMISSION', 'DISPUTE']
const MAX_PENDING = 30
const ORPHAN_HOURS = 24

export function serializeRepairMedia(m) {
  const { exp, sig } = signEvidence(m.id)
  return {
    id: m.id, itemId: m.item_id, mediaType: m.media_type, stage: m.evidence_stage, filename: m.original_filename, mimeType: m.mime_type,
    size: Number(m.byte_size), checksum: m.checksum, uploadedAt: m.created_at.toISOString(), uploadedByRole: m.uploaded_by_role, attached: !!m.entity_id,
    url: `/api/v1/media/repair-evidence/${m.id}?exp=${exp}&sig=${sig}`,
  }
}

export async function listRepairMedia(requestId) {
  const { rows } = await query('SELECT * FROM repair_media WHERE entity_id = $1 ORDER BY created_at, id', [requestId])
  return rows.map(serializeRepairMedia)
}

export async function uploadRepairParts(actor, parts) {
  const s = await getSettings()
  const limits = { image: s.max_image_mb * 1048576, video: s.max_video_mb * 1048576 }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM repair_media WHERE uploaded_by = $1 AND entity_id IS NULL AND created_at > NOW() - INTERVAL '${ORPHAN_HOURS} hours'`, [actor.userId])
  let pending = rows[0].n
  const results = []
  for await (const part of parts) {
    const filename = String(part.filename || 'upload').replace(/[^\w.\- ()]/g, '_').slice(0, 255)
    try {
      if (pending >= MAX_PENDING) throw new EvidenceError('TOO_MANY_PENDING', 'Too many unattached uploads. Submit your request or remove some files.', 429)
      const saved = await saveEvidence(part, { limitsFor: (k) => (k === 'VIDEO' ? limits.video : limits.image) })
      try {
        const { rows: ins } = await query(
          `INSERT INTO repair_media (media_type, storage_key, original_filename, mime_type, byte_size, checksum, uploaded_by, uploaded_by_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [saved.kind, saved.storageKey, filename, saved.mime, saved.size, saved.checksum, actor.userId, actor.kind])
        pending += 1
        results.push({ ok: true, filename, media: serializeRepairMedia(ins[0]) })
      } catch (dbErr) {
        await removeEvidence(saved.storageKey)
        throw dbErr
      }
    } catch (err) {
      part.file?.resume?.()
      results.push(err instanceof EvidenceError
        ? { ok: false, filename, code: err.code, message: err.message, status: err.statusCode }
        : { ok: false, filename, code: 'STORAGE_FAILED', message: 'The file could not be saved. Please retry.', status: 503 })
    }
  }
  return results
}

export async function discardRepairPending(actor, mediaId) {
  const { rows } = await query('DELETE FROM repair_media WHERE id = $1 AND uploaded_by = $2 AND entity_id IS NULL RETURNING storage_key', [mediaId, actor.userId])
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'Upload not found, or it is already attached to a request', 404)
  await removeEvidence(rows[0].storage_key)
}

export async function claimRepairMedia(client, request, actor, mediaIds, stage = 'CUSTOMER_SUBMISSION', itemId = null) {
  const ids = [...new Set(Array.isArray(mediaIds) ? mediaIds : [])]
  if (!ids.length) return
  if (ids.length > 30 || ids.some((i) => typeof i !== 'string' || !/^[0-9a-f-]{36}$/i.test(i))) throw new RepairError('VALIDATION', 'Invalid media list', 422)
  if (!REPAIR_STAGES.includes(stage)) throw new RepairError('VALIDATION', 'Unknown evidence stage', 422)
  if (actor.kind === 'CUSTOMER') {
    if (request.user_id !== actor.userId) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
    if (!CUSTOMER_STAGES.includes(stage)) throw new RepairError('FORBIDDEN', 'Customers can only add submission or dispute evidence', 403)
  } else if (actor.kind === 'VENDOR') {
    if (!actor.vendorId || request.assigned_vendor_id !== actor.vendorId) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
    if (CUSTOMER_STAGES.includes(stage)) throw new RepairError('FORBIDDEN', 'Service centres add intake, diagnosis, progress, QC or delivery evidence', 403)
  }
  if (['REJECTED', 'CANCELLED'].includes(request.status) && stage !== 'DISPUTE') throw new RepairError('INVALID_STATE', 'This request is closed', 409)
  if (itemId) {
    const { rows } = await client.query('SELECT 1 FROM repair_items WHERE id = $1 AND request_id = $2', [itemId, request.id])
    if (!rows[0]) throw new RepairError('VALIDATION', 'That device is not on this request', 422)
  }
  const { rows } = await client.query('SELECT * FROM repair_media WHERE id = ANY($1) FOR UPDATE', [ids])
  const mine = rows.filter((m) => m.uploaded_by === actor.userId)
  if (mine.length !== ids.length) throw new RepairError('NOT_FOUND', 'One or more uploads were not found', 404)
  if (mine.some((m) => m.entity_id)) throw new RepairError('ALREADY_ATTACHED', 'One or more files are already attached to a request', 409)
  const s = await getSettings(client)
  const { rows: have } = await client.query('SELECT media_type, COUNT(*)::int AS n FROM repair_media WHERE entity_id = $1 AND evidence_stage = $2 GROUP BY media_type', [request.id, stage])
  const cur = { IMAGE: 0, VIDEO: 0, ...Object.fromEntries(have.map((h) => [h.media_type, h.n])) }
  const add = { IMAGE: mine.filter((m) => m.media_type === 'IMAGE').length, VIDEO: mine.filter((m) => m.media_type === 'VIDEO').length }
  // Bulk (B2B) requests carry many devices, so photo limits scale with the device count.
  const { rows: cnt } = await client.query('SELECT COUNT(*)::int AS n FROM repair_items WHERE request_id = $1', [request.id])
  const maxImages = s.max_images * Math.max(1, cnt[0].n)
  if (cur.IMAGE + add.IMAGE > maxImages) throw new RepairError('TOO_MANY_PHOTOS', `At most ${maxImages} photos are allowed for this stage`, 422)
  if (cur.VIDEO + add.VIDEO > s.max_videos * Math.max(1, cnt[0].n)) throw new RepairError('TOO_MANY_VIDEOS', 'Too many videos for this stage', 422)
  await client.query('UPDATE repair_media SET entity_id = $2, claimed_at = NOW(), evidence_stage = $3, item_id = $4 WHERE id = ANY($1)', [ids, request.id, stage, itemId])
  await addEvent(client, request.id, 'EVIDENCE_ADDED', `${ids.length} file${ids.length === 1 ? '' : 's'} added (${stage.toLowerCase().replace(/_/g, ' ')})`, actor, { meta: { stage, mediaIds: ids } })
}

export const attachRepairMedia = (actor, requestId, mediaIds, stage, itemId) =>
  tx(async (client) => {
    const r = await lock(client, requestId, actor)
    await claimRepairMedia(client, r, actor, mediaIds, stage, itemId)
  })

export async function repairLinkFor(actor, mediaId, getRequest) {
  const { rows } = await query('SELECT * FROM repair_media WHERE id = $1', [mediaId])
  const m = rows[0]
  if (!m) throw new RepairError('NOT_FOUND', 'Evidence not found', 404)
  if (!m.entity_id) { if (m.uploaded_by !== actor.userId) throw new RepairError('NOT_FOUND', 'Evidence not found', 404) } else await getRequest(m.entity_id)
  return serializeRepairMedia(m)
}

export async function getStoredRepairMedia(id) {
  const { rows } = await query('SELECT id, storage_key, mime_type, byte_size FROM repair_media WHERE id = $1', [id])
  return rows[0] || null
}

export async function purgeOrphanRepairMedia(hours = ORPHAN_HOURS) {
  const { rows } = await query(`DELETE FROM repair_media WHERE entity_id IS NULL AND created_at < NOW() - ($1 || ' hours')::interval RETURNING storage_key`, [String(hours)])
  for (const r of rows) await removeEvidence(r.storage_key)
  return rows.length
}
