/**
 * Proposal Media Routes — Fastify Plugin for Proposal Media, Variants & Specs Endpoints
 * Source of truth: Blueprint §06.2, Phase 3B
 *
 * @module modules/catalogue/proposal-media.routes
 */

import { CatalogueRepository } from './catalogue.repository.js'
import { ProposalMediaRepository } from './proposal-media.repository.js'
import { ProposalMediaService } from './proposal-media.service.js'
import { ProposalMediaController } from './proposal-media.controller.js'
import { AddMediaSchema, AddVariantSchema, AddSpecificationSchema } from './proposal-media.schema.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

export async function proposalMediaRoutes(fastify) {
  const proposalRepository = new CatalogueRepository()
  const repository = new ProposalMediaRepository()
  const service = new ProposalMediaService(repository, proposalRepository)
  const controller = new ProposalMediaController(service)

  // 1. Media Endpoints
  fastify.post('/proposals/:proposalId/media', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.update'),
      requireVendorScope(),
    ],
    schema: { body: AddMediaSchema },
    handler: controller.addMedia,
  })

  fastify.get('/proposals/:proposalId/media', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.view'),
    ],
    handler: controller.getMedia,
  })

  fastify.delete('/proposals/:proposalId/media/:mediaId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.update'),
      requireVendorScope(),
    ],
    handler: controller.deleteMedia,
  })

  // 2. Variants Endpoints
  fastify.post('/proposals/:proposalId/variants', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.update'),
      requireVendorScope(),
    ],
    schema: { body: AddVariantSchema },
    handler: controller.addVariant,
  })

  fastify.get('/proposals/:proposalId/variants', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.view'),
    ],
    handler: controller.getVariants,
  })

  // 3. Specifications Endpoints
  fastify.post('/proposals/:proposalId/specifications', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.update'),
      requireVendorScope(),
    ],
    schema: { body: AddSpecificationSchema },
    handler: controller.addSpecification,
  })

  fastify.get('/proposals/:proposalId/specifications', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('product_proposals.view'),
    ],
    handler: controller.getSpecifications,
  })
}

export default proposalMediaRoutes
