// The pure parts of inline-images: base64, half-block packing, sizing, and
// finding images in what tools return. Nothing here reaches `$`.

export type Raw = { data: string }
export type Size = { width: number; height: number }

const IMAGE_TOKEN = /\[Image #(\d+)\]/g

const DEFAULT = 0x01000000

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(256)
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (LOOKUP[clean.charCodeAt(i)]! << 18) | (LOOKUP[clean.charCodeAt(i + 1)]! << 12) |
      (LOOKUP[clean.charCodeAt(i + 2)]! << 6) | LOOKUP[clean.charCodeAt(i + 3)]!
    out[o++] = n >> 16
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    parts.push(
      ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! +
      (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[n & 63]! : '='),
    )
  }
  return parts.join('')
}

export function pack(px: Uint8Array, columns: number, rows: number): string {
  // One '▀' per cell: the foreground is the upper pixel, the background the
  // lower; a transparent pixel is the terminal's own background.
  const words = new Uint32Array(columns * rows * 3)
  const color = (i: number) =>
    px[i + 3]! < 96 ? DEFAULT : (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const cell = (y * columns + x) * 3
      const top = color((2 * y * columns + x) * 4)
      const bottom = color(((2 * y + 1) * columns + x) * 4)
      if (top === DEFAULT) {
        words[cell] = bottom === DEFAULT ? 0x20 : 0x2584
        words[cell + 1] = bottom
        words[cell + 2] = DEFAULT
      } else {
        words[cell] = 0x2580
        words[cell + 1] = top
        words[cell + 2] = bottom
      }
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// The box an image fills, in cells: no wider than `maxColumns` or (unless
// upscaled) its own pixels at about 8 a cell, no taller than `maxRows`;
// `cellAspect` is a cell's height over its width.
export function fit(image: Size, maxColumns: number, maxRows: number, cellAspect: number, isUpscaled = false) {
  const natural = isUpscaled ? Infinity : Math.ceil(image.width / 8)
  let columns = Math.max(1, Math.min(maxColumns, natural, 255))
  let rows = Math.max(1, Math.round((columns * image.height) / image.width / cellAspect))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(columns, Math.round((rows * cellAspect * image.width) / image.height)))
  }
  return { columns, rows: Math.min(rows, 255) }
}

// Whether the bytes are an animation: a GIF that loops or has a second
// frame, or a WebP with its animation flag. Only the first frame is drawn.
export function isAnimated(bytes: Uint8Array): boolean {
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n))
  if (ascii(0, 4) === 'GIF8') {
    let frames = 0
    for (let i = 0; i + 1 < bytes.length; i++) {
      // An application extension (NETSCAPE2.0 loops) or a second graphic
      // control block, each led by 0x21; a guess, but cheap and close.
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xff && ascii(i + 3, 8) === 'NETSCAPE') return true
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4 && ++frames > 1) return true
    }
    return false
  }
  return ascii(0, 4) === 'RIFF' && ascii(8, 8) === 'WEBPVP8X' && (bytes[20]! & 0x02) !== 0
}

// Every image in a tool's output or a content block, whatever its spelling:
// an API image block, an MCP one, the Read tool's record, a PDF's pages.
export function imagesIn(value: unknown, out: Raw[] = [], depth = 0): Raw[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) imagesIn(item, out, depth + 1)
    return out
  }
  const o = value as Record<string, unknown>
  const source = o.source as Record<string, unknown> | undefined
  const mime = String(o.media_type ?? o.mediaType ?? o.mimeType ?? o.type ?? source?.media_type ?? '')
  const data = o.base64 ?? o.data ?? source?.data
  if (typeof data === 'string' && data.length > 64 && (mime.startsWith('image/') || o.type === 'image')) {
    out.push({ data })
    return out
  }
  for (const key of Object.keys(o)) imagesIn(o[key], out, depth + 1)
  return out
}

// The `[Image #N]` numbers a draft holds, each once, in order.
export function draftImages(text: string): number[] {
  return [...new Set(Array.from(text.matchAll(IMAGE_TOKEN), m => Number(m[1])))]
}

// The draft with `[Image #N]` taken out, and the space it leaves doubled.
export function withoutImage(text: string, n: number): string {
  return text
    .replace(new RegExp(`\\[Image #${n}\\]`, 'g'), '\0')
    .replace(/ ?\0 ?/g, gap => (gap.length === 3 ? ' ' : ''))
}
