import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { updateProductSchema, createProductSchema } from '../../../src/modules/products/products.schema.js'

// Regression test for a real production bug: `nutritionInfo` was declared
// as `{ type: 'object', additionalProperties: { type: 'string' } }`. That
// looks like it allows arbitrary string-valued keys, but this app's Fastify
// instance is configured with the AJV option `removeAdditional: 'all'`
// (src/app.js) — which strips every key not explicitly named in
// `properties`, regardless of what `additionalProperties`'s sub-schema
// would otherwise allow. Every nutrition value (arbitrary keys like
// "Energy"/"Protein") was silently wiped to `{}` by validation before the
// route handler ever saw it, even though the request returned 200.
// `patternProperties: { '.*': ... }` matches keys directly instead of
// falling under "additional", so it survives — mirrors `highlights`, which
// already used this correct pattern.
function makeValidator(schema) {
  const ajv = new Ajv({
    removeAdditional: 'all',
    useDefaults: true,
    coerceTypes: 'array',
  })
  return ajv.compile(schema.body)
}

describe('products.schema — nutritionInfo survives removeAdditional: all', () => {
  it('update schema keeps arbitrary nutrition keys instead of stripping them to {}', () => {
    const validate = makeValidator(updateProductSchema)
    const body = {
      nutritionInfo: { Energy: '18 kcal', Protein: '0.9 g', Carbohydrates: '3.9 g' },
    }

    const valid = validate(body)

    expect(valid).toBe(true)
    expect(body.nutritionInfo).toEqual({
      Energy: '18 kcal',
      Protein: '0.9 g',
      Carbohydrates: '3.9 g',
    })
  })

  it('create schema keeps arbitrary nutrition keys instead of stripping them to {}', () => {
    const validate = makeValidator(createProductSchema)
    const body = {
      name: 'Tomato (Tameta)',
      price: 15,
      categoryId: '11111111-1111-1111-1111-111111111111',
      nutritionInfo: { Fat: '0.2 g', Fiber: '1.2 g' },
    }

    const valid = validate(body)

    expect(valid).toBe(true)
    expect(body.nutritionInfo).toEqual({ Fat: '0.2 g', Fiber: '1.2 g' })
  })
})
