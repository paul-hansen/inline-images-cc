import { describe, expect, test } from 'claude-code/testing'

import { draftImages, fit, fromBase64, imagesIn, installCommand, isAnimated, pack, toBase64, withoutImage } from '../hooks/pixels'

const DATA = 'A'.repeat(100)

describe('fit', () => {
  test('a small image keeps about 8 pixels a cell', async () => {
    expect(fit({ width: 80, height: 40 }, 100, 50, 2)).toEqual({ columns: 10, rows: 3 })
  })

  test('a wide image is held to the columns', async () => {
    expect(fit({ width: 4000, height: 1000 }, 60, 50, 2)).toEqual({ columns: 60, rows: 8 })
  })

  test('a tall image is held to the rows, its columns shrunk to keep the shape', async () => {
    expect(fit({ width: 400, height: 4000 }, 100, 10, 2)).toEqual({ columns: 2, rows: 10 })
  })

  test('upscaled, a small image fills the box', async () => {
    expect(fit({ width: 16, height: 16 }, 40, 100, 2, true)).toEqual({ columns: 40, rows: 20 })
  })

  test('never past 255 either way, nor under 1', async () => {
    const huge = fit({ width: 100_000, height: 100_000 }, 1000, 1000, 2)
    expect(huge.columns).toBeLessThanOrEqual(255)
    expect(huge.rows).toBeLessThanOrEqual(255)
    expect(fit({ width: 10_000, height: 1 }, 50, 50, 2)).toEqual({ columns: 50, rows: 1 })
  })
})

describe('pack', () => {
  // One cell's three words: glyph, foreground, background.
  const cell = (top: number[], bottom: number[]) => {
    const words = new Uint32Array(fromBase64(pack(new Uint8Array([...top, ...bottom]), 1, 1)).buffer)
    return Array.from(words)
  }
  const DEFAULT = 0x01000000

  test('two opaque pixels: an upper half block, top over bottom', async () => {
    expect(cell([255, 0, 0, 255], [0, 0, 255, 255])).toEqual([0x2580, 0xff0000, 0x0000ff])
  })

  test('a transparent top: a lower half block on the terminal background', async () => {
    expect(cell([255, 0, 0, 0], [0, 255, 0, 255])).toEqual([0x2584, 0x00ff00, DEFAULT])
  })

  test('a transparent bottom: the upper half on the terminal background', async () => {
    expect(cell([1, 2, 3, 255], [0, 0, 0, 10])).toEqual([0x2580, 0x010203, DEFAULT])
  })

  test('both transparent: a space', async () => {
    expect(cell([0, 0, 0, 0], [0, 0, 0, 0])).toEqual([0x20, DEFAULT, DEFAULT])
  })
})

describe('base64', () => {
  test('round-trips every length mod 3', async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255)
      const text = toBase64(bytes)
      expect(text).toBe(btoa(String.fromCharCode(...bytes)))
      expect(Array.from(fromBase64(text))).toEqual(Array.from(bytes))
    }
  })
})

describe('imagesIn', () => {
  test('an API image block', async () => {
    expect(imagesIn([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } }]))
      .toEqual([{ data: DATA }])
  })

  test('an MCP image', async () => {
    expect(imagesIn({ content: [{ type: 'image', mimeType: 'image/jpeg', data: DATA }] })).toEqual([{ data: DATA }])
  })

  test('the Read tool’s record', async () => {
    expect(imagesIn({ type: 'image', file: { base64: DATA, type: 'image/png' } })).toEqual([{ data: DATA }])
  })

  test('a PDF’s pages, each one', async () => {
    const page = { type: 'image', mediaType: 'image/png', data: DATA }
    expect(imagesIn({ type: 'pdf', file: { pages: [page, page] } })).toHaveLength(2)
  })

  test('not text, short data, or what lies past six levels', async () => {
    expect(imagesIn({ type: 'text', text: DATA })).toEqual([])
    expect(imagesIn({ type: 'image', data: 'abc' })).toEqual([])
    let deep: unknown = { type: 'image', data: DATA }
    for (let i = 0; i < 8; i++) deep = { inner: deep }
    expect(imagesIn(deep)).toEqual([])
  })
})

describe('the draft', () => {
  test('names each image once, in order', async () => {
    expect(draftImages('[Image #2] a [Image #1] b [Image #2]')).toEqual([2, 1])
    expect(draftImages('no images')).toEqual([])
  })

  test('taking one out leaves single spaces', async () => {
    expect(withoutImage('see [Image #1] and [Image #2]', 1)).toBe('see and [Image #2]')
    expect(withoutImage('[Image #1] first', 1)).toBe('first')
    expect(withoutImage('last [Image #1]', 1)).toBe('last')
    expect(withoutImage('[Image #12] keeps [Image #1]', 1)).toBe('[Image #12] keeps')
  })
})

describe('isAnimated', () => {
  const bytes = (...parts: Array<string | number[]>) =>
    new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? Array.from(p, c => c.charCodeAt(0)) : p)))

  test('a looping GIF', async () => {
    expect(isAnimated(bytes('GIF89a', [0, 0, 0x21, 0xff, 11], 'NETSCAPE2.0'))).toBe(true)
  })

  test('a GIF of two frames, and one of one', async () => {
    const control = [0x21, 0xf9, 4, 0, 0, 0, 0, 0]
    expect(isAnimated(bytes('GIF89a', control, [1, 2], control))).toBe(true)
    expect(isAnimated(bytes('GIF89a', control, [1, 2]))).toBe(false)
  })

  test('a WebP by its animation flag', async () => {
    const head = (flags: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [0, 0, 0, 0, flags])
    expect(isAnimated(head(0x02))).toBe(true)
    expect(isAnimated(head(0x10))).toBe(false)
  })

  test('a PNG', async () => {
    expect(isAnimated(bytes([0x89], 'PNG'))).toBe(false)
  })
})

describe('installCommand', () => {
  test('the OS’s usual manager wins over one also present', async () => {
    expect(installCommand('Linux', ['brew', 'pacman'])).toBe('sudo pacman -S imagemagick')
    expect(installCommand('Darwin', ['nix-env', 'brew'])).toBe('brew install imagemagick')
  })

  test('pkg means FreeBSD’s package on FreeBSD and Termux’s on Linux', async () => {
    expect(installCommand('FreeBSD', ['pkg'])).toBe('sudo pkg install ImageMagick7')
    expect(installCommand('Linux', ['pkg'])).toBe('pkg install imagemagick')
  })

  test('Git Bash and MSYS count as Windows', async () => {
    expect(installCommand('MINGW64_NT-10.0-22631', ['scoop', 'winget'])).toBe('winget install ImageMagick.Q16-HDRI')
  })

  test('nothing when no manager fits', async () => {
    expect(installCommand('Linux', [])).toBeNull()
    expect(installCommand('SunOS', ['pkg'])).toBeNull()
  })
})
