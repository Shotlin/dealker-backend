import { z } from 'zod'

export const FOOD_TYPES = Object.freeze({
  VEG: 'VEG',
  NON_VEG: 'NON_VEG',
  EGG: 'EGG',
  NONE: 'NONE',
})

export const ORIGIN_TAGS = Object.freeze({
  IMPORTED: 'IMPORTED',
  LOCAL: 'LOCAL',
  NONE: 'NONE',
})

export const FOOD_TYPE_VALUES = Object.values(FOOD_TYPES)
export const ORIGIN_TAG_VALUES = Object.values(ORIGIN_TAGS)

export const createProductFamilySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(300).optional(),
  category_id: z.string().uuid().optional().nullable(),
  thumbnail_url: z.string().url().max(2000).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
})

export const updateProductFamilySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(300).optional(),
  category_id: z.string().uuid().optional().nullable(),
  thumbnail_url: z.string().max(2000).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
)

export const listProductFamiliesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  category_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
})

export const productFamilyIdParamSchema = z.object({
  id: z.string().uuid(),
})
