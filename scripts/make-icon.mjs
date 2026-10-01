// Draws the Parallax icon (three overlapping circles on a dark tile) and writes
// build/icon.png and build/icon.ico. No image libraries needed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BACKGROUND = [23, 21, 31]
// Positions on a 64-unit grid, matching src/renderer/public/favicon.svg.
const CIRCLES = [
  { x: 24, y: 26, r: 14, color: [124, 92, 255], opacity: 0.95 },
  { x: 40, y: 26, r: 14, color: [20, 184, 166], opacity: 0.9 },
  { x: 32, y: 40, r: 14, color: [249, 115, 98], opacity: 0.9 },
]
const CORNER = 14

function insideTile(x, y) {
  const cx = Math.min(Math.max(x, CORNER), 64 - CORNER)
  const cy = Math.min(Math.max(y, CORNER), 64 - CORNER)
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2
}

function sample(x, y) {
  if (!insideTile(x, y)) return null
  let rgb = BACKGROUND.map((c) => c / 255)
  for (const circle of CIRCLES) {
    if ((x - circle.x) ** 2 + (y - circle.y) ** 2 > circle.r ** 2) continue
    const top = circle.color.map((c) => c / 255)
    // "Screen" blending, like light from several projectors.
    rgb = rgb.map((base, i) => base + (1 - (1 - base) * (1 - top[i]) - base) * circle.opacity)
  }
  return rgb
}

function render(size, supersample = 4) {
  const pixels = Buffer.alloc(size * size * 4)
  const step = 64 / size
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const s = sample((px + (sx + 0.5) / supersample) * step, (py + (sy + 0.5) / supersample) * step)
          if (!s) continue
          r += s[0]
          g += s[1]
          b += s[2]
          a += 1
        }
      }
      const i = (py * size + px) * 4
      const n = supersample * supersample
      if (a > 0) {
        pixels[i] = Math.round((r / a) * 255)
        pixels[i + 1] = Math.round((g / a) * 255)
        pixels[i + 2] = Math.round((b / a) * 255)
      }
      pixels[i + 3] = Math.round((a / n) * 255)
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size) {
  const pixels = render(size)
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png(512))
writeFileSync('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256]))
console.log('Wrote build/icon.png and build/icon.ico')
