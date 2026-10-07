import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupportService } from '../../../src/modules/support/support.service.js'

describe('Phase 10 Support Tickets, Recalls & Traceability Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createTicket: vi.fn(),
      findTicketById: vi.fn(),
      assignTicket: vi.fn(),
      updateTicketStatus: vi.fn(),
      addTicketComment: vi.fn(),
      logStatusTransition: vi.fn(),
      createRecall: vi.fn(),
      addRecallItem: vi.fn(),
      updateRecallStatus: vi.fn(),
      findRecallById: vi.fn(),
      recordTraceabilityEvent: vi.fn(),
      getTraceabilityHistory: vi.fn(),
      listTickets: vi.fn(),
    }
    service = new SupportService(repositoryMock)
  })

  describe('Support Tickets Lifecycle', () => {
    it('creates support ticket cleanly with OPEN status', async () => {
      repositoryMock.createTicket.mockResolvedValueOnce({ id: 't-1', ticket_number: 'TICK-101', status: 'OPEN' })

      const ticket = await service.createTicket('user-1', {
        subject: 'Damaged item received',
        description: 'Packaging was damaged upon arrival',
      })

      expect(repositoryMock.createTicket).toHaveBeenCalledWith(
        expect.stringMatching(/^TICK-/),
        'user-1',
        'Damaged item received',
        'Packaging was damaged upon arrival'
      )
      expect(ticket.id).toBe('t-1')
    })

    it('assigns ticket to support agent', async () => {
      repositoryMock.findTicketById.mockResolvedValueOnce({ id: 't-1', status: 'OPEN' })
      repositoryMock.assignTicket.mockResolvedValueOnce({ id: 't-1', status: 'ASSIGNED', assigned_to: 'agent-1' })

      const updated = await service.assignTicket('t-1', 'admin-1', 'agent-1')

      expect(repositoryMock.assignTicket).toHaveBeenCalledWith('t-1', 'agent-1')
      expect(updated.assigned_to).toBe('agent-1')
    })

    it('rejects adding comment on CLOSED ticket with 400 TICKET_CLOSED_LOCKED', async () => {
      repositoryMock.findTicketById.mockResolvedValueOnce({ id: 't-1', status: 'CLOSED' })

      await expect(service.addTicketComment('t-1', 'user-1', 'Late note')).rejects.toThrow(
        'Cannot add comments to a closed support ticket'
      )
    })

    it('reopens CLOSED ticket cleanly', async () => {
      repositoryMock.findTicketById.mockResolvedValueOnce({ id: 't-1', status: 'CLOSED' })
      repositoryMock.updateTicketStatus.mockResolvedValueOnce({ id: 't-1', status: 'REOPENED' })

      const updated = await service.updateTicketStatus('t-1', 'user-1', 'REOPENED', 'Issue persists')

      expect(repositoryMock.updateTicketStatus).toHaveBeenCalledWith('t-1', 'REOPENED')
      expect(updated.status).toBe('REOPENED')
    })
  })

  describe('Product Recalls & Traceability', () => {
    it('creates product recall and links affected batches with traceability events', async () => {
      repositoryMock.createRecall.mockResolvedValueOnce({ id: 'rec-1', recall_number: 'RECALL-101', status: 'DRAFT' })
      repositoryMock.addRecallItem.mockResolvedValueOnce({ id: 'ri-1', product_id: 'p-1', batch_number: 'BATCH-BAD' })

      const recall = await service.createRecall('admin-1', {
        title: 'Cold Chain Failure',
        reason: 'Temperature spike detected during transport',
        items: [{ product_id: 'p-1', batch_number: 'BATCH-BAD', affected_quantity: 50 }],
      })

      expect(repositoryMock.addRecallItem).toHaveBeenCalledWith('rec-1', 'p-1', null, 'BATCH-BAD', 50)
      expect(repositoryMock.recordTraceabilityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'PRODUCT_RECALL_LINKED',
          product_id: 'p-1',
          batch_number: 'BATCH-BAD',
        })
      )
      expect(recall.id).toBe('rec-1')
    })

    it('retrieves batch traceability history', async () => {
      repositoryMock.getTraceabilityHistory.mockResolvedValueOnce([
        { id: 'te-1', event_type: 'PRODUCT_RECALL_LINKED', batch_number: 'BATCH-BAD' },
      ])

      const history = await service.getTraceabilityHistory('p-1', 'BATCH-BAD')

      expect(repositoryMock.getTraceabilityHistory).toHaveBeenCalledWith('p-1', 'BATCH-BAD')
      expect(history).toHaveLength(1)
    })
  })
})
