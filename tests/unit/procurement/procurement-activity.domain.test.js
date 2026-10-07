import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcurementActivityService } from '../../../src/modules/procurement/procurement-activity.service.js'

describe('Phase 4B Procurement Media & Supplier Audit Trails Unit Tests', () => {
  let repositoryMock
  let procurementRepoMock
  let service

  beforeEach(() => {
    repositoryMock = {
      addComment: vi.fn(),
      getComments: vi.fn(),
      addCategorizedMedia: vi.fn(),
      getCategorizedMedia: vi.fn(),
      getAuditLogs: vi.fn(),
      getCombinedTimeline: vi.fn(),
    }
    procurementRepoMock = {
      findOrderById: vi.fn(),
    }
    service = new ProcurementActivityService(repositoryMock, procurementRepoMock)
  })

  describe('Comments Management', () => {
    it('adds comment to open procurement order', async () => {
      procurementRepoMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
      repositoryMock.addComment.mockResolvedValueOnce({ id: 'c-1', comment: 'Quality verified on arrival' })

      const comment = await service.addComment('po-1', 'v-1', 'user-1', 'Quality verified on arrival')

      expect(repositoryMock.addComment).toHaveBeenCalledWith('po-1', 'user-1', 'Quality verified on arrival')
      expect(comment.id).toBe('c-1')
    })

    it('rejects comment addition if order status is CLOSED with 400 ORDER_CLOSED_LOCKED', async () => {
      procurementRepoMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'CLOSED' })

      await expect(
        service.addComment('po-1', 'v-1', 'user-1', 'Late note')
      ).rejects.toThrow('Procurement comments and evidence cannot be modified after order is CLOSED')
    })
  })

  describe('Categorized Media Evidence', () => {
    it('adds categorized evidence cleanly', async () => {
      procurementRepoMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
      repositoryMock.addCategorizedMedia.mockResolvedValueOnce({ id: 'm-1', category: 'INSPECTION_REPORT', sort_order: 1 })

      const media = await service.addCategorizedMedia('po-1', 'v-1', 'user-1', {
        media_type: 'PDF',
        file_key: 'key-doc.pdf',
        category: 'INSPECTION_REPORT',
        sort_order: 1,
      })

      expect(repositoryMock.addCategorizedMedia).toHaveBeenCalledOnce()
      expect(media.category).toBe('INSPECTION_REPORT')
    })
  })

  describe('Timeline & Audit History', () => {
    it('retrieves combined chronological audit timeline', async () => {
      repositoryMock.getCombinedTimeline.mockResolvedValueOnce([
        { type: 'EVIDENCE', timestamp: '2026-08-04T12:00:00Z' },
        { type: 'COMMENT', timestamp: '2026-08-04T11:00:00Z' },
        { type: 'AUDIT', timestamp: '2026-08-04T10:00:00Z' },
      ])

      const timeline = await service.getAuditTimeline('po-1')

      expect(timeline).toHaveLength(3)
      expect(timeline[0].type).toBe('EVIDENCE')
      expect(timeline[2].type).toBe('AUDIT')
    })
  })
})
