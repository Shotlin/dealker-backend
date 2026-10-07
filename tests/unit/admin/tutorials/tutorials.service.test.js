import { describe, expect, it } from 'vitest'
import { extractYouTubeVideoId } from '../../../../src/modules/admin/tutorials/tutorials.service.js'

describe('extractYouTubeVideoId', () => {
  it('extracts from a standard watch URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts from a watch URL with extra query params before v=', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&index=2')).toBe('dQw4w9WgXcQ')
  })

  it('extracts from a shortened youtu.be link', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts from a youtu.be link with a share query param', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc123')).toBe('dQw4w9WgXcQ')
  })

  it('extracts from a Shorts URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts from an embed URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('returns null for a non-YouTube URL', () => {
    expect(extractYouTubeVideoId('https://vimeo.com/12345678')).toBeNull()
  })

  it('returns null for an empty/missing value', () => {
    expect(extractYouTubeVideoId('')).toBeNull()
    expect(extractYouTubeVideoId(undefined)).toBeNull()
  })
})
