import { deflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * A minimal ZIP writer and entry reader.
 *
 * Watchside has no build-time dependencies beyond Vite and TypeScript, and one
 * release archive is not a reason to add one. This writes the small subset of
 * the format that every extractor understands: local headers, deflated or
 * stored data, and a central directory.
 *
 * No ZIP64, no encryption, no directory entries beyond explicit ones - the
 * package is a handful of small files.
 */

const SIGNATURE = {
  local: 0x04034b50,
  central: 0x02014b50,
  end: 0x06054b50,
}

/** DOS date/time. Taken from a caller-supplied date so builds stay comparable. */
function dosTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * Writes `entries` ({ name, source }) to `zipPath`.
 *
 * `name` is the path inside the archive, always with forward slashes, so an
 * archive built on Windows extracts correctly everywhere.
 */
export function writeZip(zipPath, entries, { date = new Date() } = {}) {
  const { time, day } = dosTime(date)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.source) ? entry.source : readFileSync(entry.source)
    const deflated = deflateRawSync(raw, { level: 9 })
    // Storing is smaller than deflating for tiny or incompressible files.
    const useDeflate = deflated.length < raw.length
    const data = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIGNATURE.local, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIGNATURE.central, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0o644 << 16, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIGNATURE.end, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  writeFileSync(zipPath, Buffer.concat([...locals, centralBuffer, end]))
}

/**
 * Lists the entry names recorded in an archive's central directory.
 *
 * Read back from the finished file rather than remembered from the write, so
 * the inspection step is checking the artifact rather than our intentions.
 */
export function listZip(zipPath) {
  const buffer = readFileSync(zipPath)

  // The end record is at the tail, after an optional comment.
  let end = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === SIGNATURE.end) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`${zipPath} is not a zip archive`)

  const count = buffer.readUInt16LE(end + 10)
  let at = buffer.readUInt32LE(end + 16)
  const names = []

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== SIGNATURE.central) {
      throw new Error(`${zipPath}: corrupt central directory at entry ${i}`)
    }
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
  }

  return names
}
