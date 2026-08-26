/**
 * A minimal store-only ZIP writer.
 *
 * The designer's work lives in a folder on their machine with no route back to
 * the repo (handoff decision 8: it comes back as a zip they download and Eric
 * unzips over `public/`). Something has to build that zip.
 *
 * Built in the browser rather than in the helper. The helper is deliberately
 * dependency-free and Node has no zip in its standard library, so it would have
 * grown this code too — and every designer running an older downloaded copy
 * would be missing the feature. Here it ships with the page.
 *
 * Stored, not deflated: game data is a few hundred kilobytes of JSON and PNG,
 * PNG is already compressed, and store-only is a format every unzipper on every
 * platform has supported since 1989. Nothing here is worth a compressor for.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** Flag bit 11: the name is UTF-8, not the archaic IBM code page. */
const UTF8_FLAG = 0x0800
/** "Stored". No compression method is negotiated. */
const STORED = 0
/** Minimum PKZIP version that can read this. 2.0 covers stored entries. */
const VERSION = 20

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string
  data: Uint8Array
}

export function makeZip(entries: readonly ZipEntry[], modified = new Date()): Uint8Array {
  const time = dosTime(modified)
  const date = dosDate(modified)
  const encoder = new TextEncoder()

  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, LOCAL_SIG, true)
    lv.setUint16(4, VERSION, true)
    lv.setUint16(6, UTF8_FLAG, true)
    lv.setUint16(8, STORED, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, CENTRAL_SIG, true)
    cv.setUint16(4, VERSION, true)
    cv.setUint16(6, VERSION, true)
    cv.setUint16(8, UTF8_FLAG, true)
    cv.setUint16(10, STORED, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true)   // extra
    cv.setUint16(32, 0, true)   // comment
    cv.setUint16(34, 0, true)   // disk
    cv.setUint16(36, 0, true)   // internal attrs
    cv.setUint32(38, 0, true)   // external attrs
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + size
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, EOCD_SIG, true)
  ev.setUint16(4, 0, true)      // this disk
  ev.setUint16(6, 0, true)      // disk with the central directory
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)     // comment length

  return concat([...locals, ...centrals, eocd])
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** DOS timestamps have two-second resolution and start in 1980. */
function dosTime(d: Date): number {
  return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
}

function dosDate(d: Date): number {
  const year = Math.max(1980, d.getFullYear())
  return ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
}

let table: Uint32Array | undefined

/** The standard CRC-32 the format requires. A wrong one makes an unopenable zip. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
