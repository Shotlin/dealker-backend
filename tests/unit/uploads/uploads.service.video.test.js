import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
vi.mock('../../../src/config/env.js', () => ({
  env: { CLOUDINARY_FOLDER: 'freshcuts' },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const uploadStreamMock = vi.fn()
vi.mock('../../../src/config/cloudinary.js', () => ({
  cloudinary: { uploader: { upload_stream: (...args) => uploadStreamMock(...args) } },
  buildCloudinaryUrl: vi.fn(),
  buildCloudinaryVariants: vi.fn(),
}))

vi.mock('../../../src/utils/cloudinary-upload.js', () => ({
  uploadImageWithCloudinaryFallback: vi.fn(),
}))

const { UploadsService } = await import('../../../src/modules/uploads/uploads.service.js')

describe('UploadsService#uploadVideo', () => {
  let service

  beforeEach(() => {
    service = new UploadsService()
    uploadStreamMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pipes the real Readable file stream into Cloudinary and resolves with the upload result', async () => {
    // A PassThrough stands in for @fastify/multipart's real, non-buffer
    // file stream — the exact class of object that a plain `.end(stream)`
    // call cannot accept (it requires a Buffer/string), which is the bug
    // this test guards against regressing.
    const fileStream = new PassThrough()
    const fakeCloudinaryWritable = new PassThrough()
    let pipedFrom = null

    uploadStreamMock.mockImplementation((options, callback) => {
      fakeCloudinaryWritable.on('finish', () => {
        callback(null, {
          secure_url: 'https://res.cloudinary.com/demo/video/upload/v1/evidence/clip.mp4',
          public_id: 'evidence/clip',
          duration: 12.5,
          format: 'mp4',
          bytes: 1024,
        })
      })
      const originalPipe = fakeCloudinaryWritable.pipe?.bind(fakeCloudinaryWritable)
      // Track that .pipe() (not .end()) is really what feeds this writable.
      const originalWrite = fakeCloudinaryWritable.write.bind(fakeCloudinaryWritable)
      fakeCloudinaryWritable.write = (chunk, ...rest) => {
        pipedFrom = pipedFrom ?? true
        return originalWrite(chunk, ...rest)
      }
      void originalPipe
      return fakeCloudinaryWritable
    })

    const resultPromise = service.uploadVideo(fileStream, { folder: 'freshcuts/evidence' })

    fileStream.end(Buffer.from('fake-video-bytes'))

    const result = await resultPromise

    expect(pipedFrom).toBe(true)
    expect(uploadStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource_type: 'video', folder: 'freshcuts/evidence' }),
      expect.any(Function),
    )
    expect(result).toEqual({
      url: 'https://res.cloudinary.com/demo/video/upload/v1/evidence/clip.mp4',
      publicId: 'evidence/clip',
      duration: 12.5,
      format: 'mp4',
      bytes: 1024,
    })
  })

  it('rejects when the upload stream reports an error', async () => {
    const fileStream = Readable.from([Buffer.from('bytes')])
    const fakeCloudinaryWritable = new PassThrough()

    uploadStreamMock.mockImplementation((options, callback) => {
      queueMicrotask(() => callback(new Error('Cloudinary rejected the upload'), null))
      return fakeCloudinaryWritable
    })

    await expect(service.uploadVideo(fileStream, {})).rejects.toThrow('Cloudinary rejected the upload')
  })

  it('propagates a source-stream error instead of hanging forever', async () => {
    const fileStream = new PassThrough()
    const fakeCloudinaryWritable = new PassThrough()
    uploadStreamMock.mockImplementation(() => fakeCloudinaryWritable)

    const resultPromise = service.uploadVideo(fileStream, {})
    fileStream.emit('error', new Error('client aborted the upload'))

    await expect(resultPromise).rejects.toThrow('client aborted the upload')
  })
})
