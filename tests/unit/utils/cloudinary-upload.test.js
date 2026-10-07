/**
 * toH264VideoUrl — fixes a real, live-confirmed playback bug: vendor
 * quality-video evidence recorded on an iPhone defaults to HEVC/H.265
 * (`codecs=hvc1`), which Android's video_player/ExoPlayer support
 * inconsistently. Confirmed directly against a real production asset:
 * its Content-Type came back `video/mp4;codecs=hvc1`, and requesting the
 * same URL with `vc_h264` inserted came back `codecs=avc1` (H.264) —
 * this pins that exact transformation.
 */
import { describe, expect, it } from 'vitest'
import { toH264VideoUrl } from '../../../src/utils/cloudinary-upload.js'

describe('toH264VideoUrl', () => {
  it('inserts a vc_h264 transformation segment right after /video/upload/', () => {
    const url = 'https://res.cloudinary.com/h9sgzkie/video/upload/v1790403289/freshcuts/evidence/j7rjss8apaovueolzjc9.mp4'
    expect(toH264VideoUrl(url)).toBe(
      'https://res.cloudinary.com/h9sgzkie/video/upload/vc_h264/v1790403289/freshcuts/evidence/j7rjss8apaovueolzjc9.mp4'
    )
  })

  it('returns null/undefined/empty input unchanged (no video for this item — never fabricate a URL)', () => {
    expect(toH264VideoUrl(null)).toBeNull()
    expect(toH264VideoUrl(undefined)).toBeUndefined()
    expect(toH264VideoUrl('')).toBe('')
  })

  it('returns a non-Cloudinary or malformed URL unchanged rather than corrupting it', () => {
    const url = 'https://example.com/some/other/video.mp4'
    expect(toH264VideoUrl(url)).toBe(url)
  })
})
