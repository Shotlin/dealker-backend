import { EventEmitter } from 'node:events'
import https from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/env.js', () => ({ env: {} }))
const { UploadsController, isAllowedCloudinaryUrl } = await import('../../../src/modules/uploads/uploads.controller.js')

function replyStub() {
  return { status: null, payload: null,
    code(status) { this.status = status; return this },
    header() { return this },
    send(payload) { this.payload = payload; return this },
  }
}

describe('Cloudinary proxy validation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts only HTTPS Cloudinary hosts without credentials or nonstandard ports', () => {
    expect(isAllowedCloudinaryUrl('https://res.cloudinary.com/demo/image/upload/photo.jpg')).toBe(true)
    for (const url of [
      'https://evilcloudinary.com/photo.jpg',
      'https://cloudinary.com.evil.example/photo.jpg',
      'http://res.cloudinary.com/photo.jpg',
      'https://user:pass@res.cloudinary.com/photo.jpg',
      'https://res.cloudinary.com:8443/photo.jpg',
      'not a url',
    ]) expect(isAllowedCloudinaryUrl(url)).toBe(false)
  })

  it('follows an allowed HTTPS redirect and returns image bytes', async () => {
    const get = vi.spyOn(https, 'get').mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter()
      req.setTimeout = () => req
      process.nextTick(() => {
        const response = new EventEmitter()
        const redirect = get.mock.calls.length === 1
        response.statusCode = redirect ? 302 : 200
        response.headers = redirect
          ? { location: 'https://res.cloudinary.com/demo/image/upload/actual.jpg' }
          : { 'content-type': 'image/jpeg' }
        response.resume = () => {}
        callback(response)
        if (!redirect) {
          response.emit('data', Buffer.from([1, 2, 3]))
          response.emit('end')
        }
      })
      return req
    })
    const reply = replyStub()
    await new UploadsController({}).proxyFile({
      query: { url: 'https://res.cloudinary.com/demo/image/upload/photo.jpg' },
      log: { warn: vi.fn(), error: vi.fn() },
    }, reply)
    expect(get).toHaveBeenCalledTimes(2)
    expect(reply.status).toBe(200)
    expect(reply.payload).toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects a redirect to a non-Cloudinary host before making a second request', async () => {
    const get = vi.spyOn(https, 'get').mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter()
      req.setTimeout = () => req
      process.nextTick(() => {
        const response = new EventEmitter()
        response.statusCode = 302
        response.headers = { location: 'http://127.0.0.1/private' }
        response.resume = () => {}
        callback(response)
      })
      return req
    })
    const reply = replyStub()
    await new UploadsController({}).proxyFile({
      query: { url: 'https://res.cloudinary.com/demo/image/upload/photo.jpg' },
      log: { warn: vi.fn(), error: vi.fn() },
    }, reply)
    expect(get).toHaveBeenCalledTimes(1)
    expect(reply.status).toBe(502)
  })
})
