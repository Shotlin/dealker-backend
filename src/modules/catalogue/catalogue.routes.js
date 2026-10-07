/**
 * Catalogue Routes — Fastify Plugin for Brands & Product Proposal Endpoints
 * Source of truth: Blueprint §06.2, Phase 3A
 *
 * @module modules/catalogue/catalogue.routes
 */

import { CatalogueRepository } from './catalogue.repository.js'
import { CatalogueService } from './catalogue.service.js'
import { CatalogueController } from './catalogue.controller.js'
import { CreateBrandSchema, CreateProposalSchema, ReviewProposalSchema } from './catalogue.schema.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

export async function catalogueRoutes(fastify) {
  const repository = new CatalogueRepository()
  const service = new CatalogueService(repository)
  const controller = new CatalogueController(service)

  // 1. Brands
  fastify.post('/brands', {
    preHandler: [fastify.authenticate, fastify.requirePermission('product_proposals.create')],
    schema: { body: CreateBrandSchema },
    handler: controller.createBrand,
  })

  fastify.get('/brands', {
    handler: controller.listBrands,
  })

  // 2. Proposals
  fastify.post('/proposals', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.create'),
      requireVendorScope(),
    ],
    schema: { body: CreateProposalSchema },
    handler: controller.createProposal,
  })

  fastify.post('/proposals/:proposalId/submit', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.create'),
      requireVendorScope(),
    ],
    handler: controller.submitProposal,
  })

  fastify.post('/proposals/:proposalId/review', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.approve'),
    ],
    schema: { body: ReviewProposalSchema },
    handler: controller.reviewProposal,
  })

  fastify.get('/proposals/:proposalId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.view'),
    ],
    handler: controller.getProposalById,
  })

  fastify.get('/proposals', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.view'),
    ],
    handler: controller.listProposals,
  })
}

export default catalogueRoutes
