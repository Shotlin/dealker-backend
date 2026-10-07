import { describe, expect, it } from 'vitest'
import {
  cleanPincode,
  cleanPincodeList,
  isValidPincode,
} from '../../../src/utils/pincode.js'

describe('cleanPincode()', () => {
  it('trims and strips ALL whitespace', () => {
    expect(cleanPincode(' 201301 ')).toBe('201301')
    expect(cleanPincode('700 016')).toBe('700016')
    expect(cleanPincode('\t201301\n')).toBe('201301')
  })

  it('stringifies numbers and maps null/undefined to blank', () => {
    expect(cleanPincode(201301)).toBe('201301')
    expect(cleanPincode(null)).toBe('')
    expect(cleanPincode(undefined)).toBe('')
  })
})

describe('isValidPincode()', () => {
  it('accepts a 6-digit PIN starting 1-9 only', () => {
    expect(isValidPincode('201301')).toBe(true)
    expect(isValidPincode('700016')).toBe(true)
    expect(isValidPincode('012345')).toBe(false)
    expect(isValidPincode('20130')).toBe(false)
    expect(isValidPincode('2013011')).toBe(false)
    expect(isValidPincode('20130a')).toBe(false)
    expect(isValidPincode(201301)).toBe(false)
  })
})

describe('cleanPincodeList()', () => {
  it('stores a duplicated PIN once (the "201301, 201301" dashboard case)', () => {
    expect(cleanPincodeList(['201301', '201301'])).toEqual(['201301'])
  })

  it('treats whitespace variants as duplicates, drops blanks, keeps first-seen order', () => {
    expect(
      cleanPincodeList([' 201301', '700 016', '', '   ', '700016', '201301 ', '110001'])
    ).toEqual(['201301', '700016', '110001'])
  })

  it('returns [] for non-arrays', () => {
    expect(cleanPincodeList(undefined)).toEqual([])
    expect(cleanPincodeList(null)).toEqual([])
    expect(cleanPincodeList('201301')).toEqual([])
  })

  it('keeps malformed non-blank entries so callers can report them', () => {
    expect(cleanPincodeList(['12345', '12345'])).toEqual(['12345'])
  })
})
