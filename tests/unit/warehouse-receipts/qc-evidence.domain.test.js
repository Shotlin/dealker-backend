import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QcEvidenceService } from '../../../src/modules/warehouse-receipts/qc-evidence.service.js'

describe('Phase 5B Quality Inspection Evidence & Dispositions Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      findInspectionById: vi.fn(),
      addMedia: vi.fn(),
      getMedia: vi.fn(),
      addDefect: vi.fn(),
      addCorrectiveAction: vi.fn(),
      getDefects: vi.fn(),
      createDisposition: vi.fn(),
      getDispositions: vi.fn(),
    }
    service = new QcEvidenceService(repositoryMock)
  })

  describe('Media Evidence', () => {
    it('adds QC media evidence metadata cleanly', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })
      repositoryMock.addMedia.mockResolvedValueOnce({ id: 'm-1', media_type: 'IMAGE', file_key: 'keys/photo.jpg' })

      const media = await service.addMedia('qc-1', 'w-1', 'user-1', {
        media_type: 'IMAGE',
        file_key: 'keys/photo.jpg',
      })

      expect(repositoryMock.addMedia).toHaveBeenCalledOnce()
      expect(media.id).toBe('m-1')
    })

    it('rejects evidence addition on closed receipt (400 RECEIPT_CLOSED_LOCKED)', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'RECEIVED' })

      await expect(
        service.addMedia('qc-1', 'w-1', 'user-1', { media_type: 'IMAGE', file_key: 'keys/photo.jpg' })
      ).rejects.toThrow('Cannot modify evidence, defects, or dispositions after receipt is CLOSED')
    })
  })

  describe('Defect Management', () => {
    it('records defect with low severity', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })
      repositoryMock.addDefect.mockResolvedValueOnce({ id: 'd-1', severity: 'LOW', title: 'Minor Scratch' })

      const defect = await service.addDefect('qc-1', 'w-1', {
        title: 'Minor Scratch',
        category: 'PACKAGING',
        severity: 'LOW',
      })

      expect(defect.severity).toBe('LOW')
    })

    it('requires corrective action plan for CRITICAL defect (400 CORRECTIVE_ACTION_REQUIRED)', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })

      await expect(
        service.addDefect('qc-1', 'w-1', {
          title: 'Temperature Abuse',
          category: 'COLD_CHAIN',
          severity: 'CRITICAL',
        })
      ).rejects.toThrow('Critical defects require a corrective action plan')
    })

    it('records CRITICAL defect with corrective action plan', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })
      repositoryMock.addDefect.mockResolvedValueOnce({ id: 'd-2', severity: 'CRITICAL', title: 'Contamination' })
      repositoryMock.addCorrectiveAction.mockResolvedValueOnce({ id: 'ca-1', action_plan: 'Quarantine lot and notify vendor' })

      const defect = await service.addDefect('qc-1', 'w-1', {
        title: 'Contamination',
        category: 'SAFETY',
        severity: 'CRITICAL',
        action_plan: 'Quarantine lot and notify vendor',
      })

      expect(repositoryMock.addCorrectiveAction).toHaveBeenCalledWith('d-2', 'Quarantine lot and notify vendor')
      expect(defect.corrective_action.id).toBe('ca-1')
    })
  })

  describe('QC Disposition Workflow', () => {
    it('submits ACCEPT disposition', async () => {
      repositoryMock.findInspectionById.mockResolvedValueOnce({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })
      repositoryMock.createDisposition.mockResolvedValueOnce({ id: 'disp-1', status: 'ACCEPT' })

      const disp = await service.submitDisposition('qc-1', 'w-1', 'reviewer-1', { status: 'ACCEPT', remarks: 'Passed criteria' })

      expect(repositoryMock.createDisposition).toHaveBeenCalledWith('qc-1', 'ACCEPT', 'reviewer-1', 'Passed criteria')
      expect(disp.status).toBe('ACCEPT')
    })

    it('submits REWORK / RETURN / REJECT dispositions cleanly', async () => {
      repositoryMock.findInspectionById.mockResolvedValue({ id: 'qc-1', warehouse_id: 'w-1', receipt_status: 'QC_PENDING' })
      repositoryMock.createDisposition.mockResolvedValue({ id: 'disp-2', status: 'REWORK' })

      const disp = await service.submitDisposition('qc-1', 'w-1', 'reviewer-1', { status: 'REWORK', remarks: 'Re-pack needed' })
      expect(disp.status).toBe('REWORK')
    })
  })
})
