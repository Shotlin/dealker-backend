import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { PNG } from 'pngjs'
import { QR_RENDER_OPTIONS } from '../../../src/utils/invoiceGenerator.js'

const payload = 'FRESHCUTS-ORDER|FC-HQC-20261001-0007|0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('invoice QR scannability', () => {
  it('keeps the 4-module white quiet zone on every side', async () => {
    const png = PNG.sync.read(await QRCode.toBuffer(payload, QR_RENDER_OPTIONS))
    const modules = QRCode.create(payload, { errorCorrectionLevel: 'L' }).modules.size
    const modulepx = png.width / (modules + 8)
    let minX = png.width, minY = png.height
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.data[(y * png.width + x) * 4] < 128) { minX = Math.min(minX, x); minY = Math.min(minY, y) }
      }
    }
    expect(minX / modulepx).toBeGreaterThanOrEqual(3.9)
    expect(minY / modulepx).toBeGreaterThanOrEqual(3.9)
  })

  it('uses low error correction so the symbol stays coarse and easy to read', () => {
    expect(QR_RENDER_OPTIONS.errorCorrectionLevel).toBe('L')
    expect(QR_RENDER_OPTIONS.margin).toBeGreaterThanOrEqual(4)
  })
})
