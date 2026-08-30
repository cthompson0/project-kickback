/**
 * A minimal PNG writer, in pure Node.
 *
 * WHY THIS EXISTS
 *
 * Every raster this repository produces comes out of Chromium's
 * `Page.captureScreenshot`, which means one encoder, one set of chunk
 * decisions, and no way to tell "our pixels are wrong" apart from "our encoder
 * wrote something the receiving platform dislikes". This is the second path:
 * same pixels, different bytes, sharing nothing with the browser.
 *
 * It is deliberately small. PNG's baseline is a signature, a header, zlib over
 * filtered scanlines, and a CRC per chunk - and writing it out is less code
 * than explaining which dependency to trust.
 *
 * Filter type 0 (None) on every scanline. Real encoders pick per-line filters
 * to compress better; here the point is a byte-for-byte predictable file, not
 * a small one.
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * Encode raw pixels as a PNG.
 *
 * @param {object} input
 * @param {Buffer} input.data   RGBA, 4 bytes per pixel, row-major
 * @param {number} input.width
 * @param {number} input.height
 * @param {boolean} [input.alpha]  false flattens to RGB, dropping the channel
 * @param {boolean} [input.srgb]   tag the file sRGB, with the matching gAMA
 * @param {number}  [input.dpi]    write a pHYs chunk at this density
 */
export function encodePng({ data, width, height, alpha = true, srgb = false, dpi = 0 }) {
  const channels = alpha ? 4 : 3
  const stride = width * channels
  // One filter byte per scanline, then the scanline itself.
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      const dst = y * (stride + 1) + 1 + x * channels
      raw[dst] = data[src]
      raw[dst + 1] = data[src + 1]
      raw[dst + 2] = data[src + 2]
      if (alpha) raw[dst + 3] = data[src + 3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = alpha ? 6 : 2 // colour type
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr)]

  if (srgb) {
    /*
     * An sRGB chunk says "these numbers are sRGB" rather than leaving a decoder
     * to assume it. Intent 0 is perceptual. The spec says a gAMA of 45455
     * should accompany it, for decoders that do not understand sRGB, so both
     * go in together or neither does.
     */
    parts.push(chunk('sRGB', Buffer.from([0])))
    const gama = Buffer.alloc(4)
    gama.writeUInt32BE(45455, 0)
    parts.push(chunk('gAMA', gama))
  }

  if (dpi > 0) {
    const phys = Buffer.alloc(9)
    const perMetre = Math.round(dpi / 0.0254)
    phys.writeUInt32BE(perMetre, 0)
    phys.writeUInt32BE(perMetre, 4)
    phys[8] = 1 // unit: metres
    parts.push(chunk('pHYs', phys))
  }

  parts.push(chunk('IDAT', deflateSync(raw, { level: 9 })))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}
