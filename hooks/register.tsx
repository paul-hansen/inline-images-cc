import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ImageRef } from '../types'

const PANE = 'image-viewer'
const ATTACHED = { plugin: 'inline-images', key: 'attached' } as const
const viewer = atom({ plugin: 'inline-images', key: 'viewer' } as const, null)

type E = Elements['terminal']
type Mode = 'image' | 'halfblock'
type Raw = { data: string }
type Config = { renderer: string; maxRows: number; thumbRows: number; cellAspect: number }

// Decodes any image ImageMagick reads (png, jpeg, gif, webp) from base64 on
// stdin to a PNG cached under its hash, then prints its size.
const PREPARE = `
M=$(command -v magick || command -v convert) || { echo "ImageMagick is not installed" >&2; exit 3; }
mkdir -p "$1"
f="$1/$2.png"
if [ -s "$f" ]; then cat >/dev/null; else
  base64 -d | "$M" '-[0]' -auto-orient -resize '2048x2048>' "png:$f.tmp" && mv "$f.tmp" "$f" || exit 4
fi
"$M" "$f" -format '%w %h' info:
`

// Scales a cached PNG to exactly cols x rows pixels and prints them as RGBA, base64.
const PIXELS = `
M=$(command -v magick || command -v convert) || exit 3
"$M" "$1" -background none -resize "$2x$3!" -depth 8 rgba:- | base64 | tr -d '\\n'
`

const DEFAULT = 0x01000000

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(256)
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

function fromBase64(text: string): Uint8Array {
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

function toBase64(bytes: Uint8Array): string {
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

let config: Config = { renderer: 'auto', maxRows: 20, thumbRows: 8, cellAspect: 2 }
const prepared = new Map<string, Promise<ImageRef | null>>()
const rasters = new Map<string, Promise<string | null>>()
let mode: Promise<Mode> | undefined
let cacheDir: Promise<string> | undefined

function detectMode($: EngineInterface): Promise<Mode> {
  mode ??= (async () => {
    if (config.renderer === 'image' || config.renderer === 'halfblock') return config.renderer
    // The engine's Image uses kitty graphics with Unicode placeholders, which
    // kitty and Ghostty draw; WezTerm, tmux and the rest get half-blocks.
    if (await $.env.get('TMUX')) return 'halfblock'
    const term = (await $.env.get('TERM')) ?? ''
    const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
    if (program === 'wezterm') return 'halfblock'
    if (term === 'xterm-kitty' || (await $.env.get('KITTY_WINDOW_ID'))) return 'image'
    if (program === 'ghostty' || term === 'xterm-ghostty') return 'image'
    return 'halfblock'
  })()
  return mode
}

function dir($: EngineInterface): Promise<string> {
  cacheDir ??= (async () => {
    const xdg = await $.env.get('XDG_CACHE_HOME')
    const home = (await $.env.get('HOME')) ?? '/tmp'
    return `${xdg || `${home}/.cache`}/claude-inline-images`
  })()
  return cacheDir
}

async function decode($: EngineInterface, raw: Raw, hash: string): Promise<ImageRef | null> {
  const folder = await dir($)
  const ran = await $.process.run(['sh', '-c', PREPARE, 'sh', folder, hash], {
    stdin: raw.data,
    timeoutMs: 20_000,
  })
  const [width = 0, height = 0] = ran.stdout.trim().split(' ').map(Number)
  if (ran.exitCode !== 0 || !(width > 0 && height > 0)) {
    $.ui.log(`inline-images: ${ran.stderr.trim() || 'could not decode an image'}`)
    return null
  }
  return { hash, path: `${folder}/${hash}.png`, width, height }
}

async function prepare($: EngineInterface, raw: Raw): Promise<ImageRef | null> {
  const bytes = fromBase64(raw.data)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hash = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
  let job = prepared.get(hash)
  if (job === undefined) {
    job = decode($, raw, hash).catch(() => null)
    prepared.set(hash, job)
    job.then(ref => ref === null && prepared.delete(hash))
  }
  return job
}

async function prepareAll($: EngineInterface, raws: Raw[]): Promise<ImageRef[]> {
  const refs = await Promise.all(raws.map(raw => prepare($, raw)))
  return refs.filter(ref => ref !== null)
}

function pack(px: Uint8Array, columns: number, rows: number): string {
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

async function scale($: EngineInterface, ref: ImageRef, columns: number, rows: number) {
  const ran = await $.process.run(
    ['sh', '-c', PIXELS, 'sh', ref.path, String(columns), String(rows * 2)],
    { timeoutMs: 20_000 },
  )
  const px = fromBase64(ran.stdout.trim())
  return ran.exitCode === 0 && px.length === columns * rows * 8 ? pack(px, columns, rows) : null
}

function halfblocks($: EngineInterface, ref: ImageRef, columns: number, rows: number) {
  const id = `${ref.hash}:${columns}x${rows}`
  let job = rasters.get(id)
  if (job === undefined) {
    job = scale($, ref, columns, rows).catch(() => null)
    rasters.set(id, job)
    job.then(cells => cells === null && rasters.delete(id))
    if (rasters.size > 200) rasters.delete(rasters.keys().next().value!)
  }
  return job
}

// The box an image fills, in cells: no wider than `maxColumns` or (unless
// upscaled) its own pixels at about 8 a cell, no taller than `maxRows`.
function fit(ref: ImageRef, maxColumns: number, maxRows: number, isUpscaled = false) {
  const natural = isUpscaled ? Infinity : Math.ceil(ref.width / 8)
  let columns = Math.max(1, Math.min(maxColumns, natural, 255))
  let rows = Math.max(1, Math.round((columns * ref.height) / ref.width / config.cellAspect))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(columns, Math.round((rows * config.cellAspect * ref.width) / ref.height)))
  }
  return { columns, rows: Math.min(rows, 255) }
}

async function picture(
  $: EngineInterface, el: E, ref: ImageRef, columns: number, rows: number, key: string,
): Promise<RenderElement> {
  const { Image, Raster, Text } = el
  const alt = `[image ${ref.width}×${ref.height}]`
  if ((await detectMode($)) === 'image') {
    const isRemote = Boolean(await $.env.get('SSH_CONNECTION'))
    const source = isRemote
      ? { png: (await $.fs.read(ref.path, { as: 'bytes' })).base64 }
      : { file: ref.path, format: 'png' as const }
    return <Image key={key} source={source} columns={columns} rows={rows} alt={alt} />
  }
  const cells = await halfblocks($, ref, columns, rows)
  return cells === null
    ? <Text dimColor>{alt}</Text>
    : <Raster key={key} columns={columns} rows={rows} cells={cells} />
}

function viewButton($: EngineInterface, el: E, ref: ImageRef, title: string, key: string) {
  const { Button } = el
  return (
    <Button
      key={key}
      plain
      label="⤢ view full size"
      onPress={async () => {
        await update($, viewer, () => ({ image: ref, title }))
        await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true })
      }}
    />
  )
}

// A strip of images by a transcript row, as the web app lays attachments
// out: side by side, wrapping, each with its own way to the full size.
async function strip(
  $: EngineInterface, el: E, refs: ImageRef[], site: string, room: number, rowsEach: number, title: string,
) {
  const { Box } = el
  const items = await Promise.all(
    refs.map(async (ref, i) => {
      const { columns, rows } = fit(ref, room, rowsEach)
      return (
        <Box key={`${site}-${i}`} flexDirection="column" width={Math.max(columns, 17)}>
          {await picture($, el, ref, columns, rows, `${site}-pic-${i}`)}
          {viewButton($, el, ref, title, `${site}-view-${i}`)}
        </Box>
      )
    }),
  )
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
      {items}
    </Box>
  )
}

// A prompt row is drawn under its stored uuid with the last group zeroed
// (86b73434-8a79-4128-8542-000000000000), so prompts are keyed by the rest.
function promptKey(uuid: string): string {
  return `prompt:${uuid.slice(0, 23)}`
}

async function attachedFor($: EngineInterface, id: string): Promise<ImageRef[]> {
  return (await $.state.get({ ...ATTACHED, id })).value ?? []
}

async function toolImages($: EngineInterface, id: string | undefined, output: unknown) {
  const stored = id === undefined ? [] : await attachedFor($, id)
  return stored.length > 0 ? stored : prepareAll($, imagesIn(output))
}

// Every image in a tool's output or a content block, whatever its spelling:
// an API image block, an MCP one, the Read tool's record, a PDF's pages.
function imagesIn(value: unknown, out: Raw[] = [], depth = 0): Raw[] {
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

export const register: Register = (on, options) => {
  config = {
    renderer: String(options.renderer ?? 'auto'),
    maxRows: Number(options.maxRows ?? 20),
    thumbRows: Number(options.thumbRows ?? 8),
    cellAspect: Number(options.cellAspect ?? 2),
  }
  mode = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'image',
      description: 'Show an image file inline in the transcript',
      argumentHint: '<path>',
    })
    return next(e)
  })

  // Remember the images each row carries as it is stored: a prompt's under its
  // uuid, a tool result's under its call.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type !== 'user') return stored
    const own = e.message.content.filter(block => block.type === 'image')
    const jobs: Array<[string, Raw[]]> = []
    if (own.length > 0 && !e.message.isMeta) jobs.push([promptKey(e.uuid), imagesIn(own)])
    for (const block of e.message.content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const found = imagesIn(block.content)
        if (found.length > 0) jobs.push([block.tool_use_id, found])
      }
    }
    for (const [id, raws] of jobs) {
      const refs = await prepareAll($, raws)
      if (refs.length > 0) await $.state.set({ ...ATTACHED, id }, refs)
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'image' }, async ($, e) => {
    const path = e.args.trim()
    return { text: path === '' ? 'Usage: /image <path>' : `Image: ${path}` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'image' } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const engine = await next(e)
    const path = e.props.args.trim()
    if (path === '') return engine
    let ref: ImageRef | null = null
    try {
      const { base64 } = await $.fs.read(path, { as: 'bytes' })
      ref = await prepare($, { data: base64 })
    } catch {}
    if (ref === null) return engine
    const el = $.ui.resolve(e)
    const { Box } = el
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 6)
    return (
      <Box flexDirection="column">
        {engine}
        {await strip($, el, [ref], e.requestId, room, config.maxRows, path)}
      </Box>
    )
  })

  // Attachments above the prompt they came with, as thumbnails.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind === 'task-notification') return next(e)
    const refs = await attachedFor($, promptKey(e.requestId))
    if (refs.length === 0) return next(e)
    const engine = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    return (
      <Box flexDirection="column">
        {await strip($, el, refs, e.requestId, 32, config.thumbRows, 'Attached image')}
        {engine}
      </Box>
    )
  })

  // A standalone tool row's result: the picture under it.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const refs = await toolImages($, e.props.tool_use_id, e.props.output)
    if (refs.length === 0) return next(e)
    const engine = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 8)
    return (
      <Box flexDirection="column">
        {engine}
        <Box paddingLeft={3}>
          {await strip($, el, refs, e.requestId, room, config.maxRows, `${e.props.tool} image`)}
        </Box>
      </Box>
    )
  })

  // A folded run of calls ("Read 2 files"): the pictures any of them returned.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)
    const found = await Promise.all(
      e.props.calls.map(call => (call.isErrored ? [] : toolImages($, call.tool_use_id, call.output))),
    )
    const refs = found.flat()
    if (refs.length === 0) return next(e)
    const engine = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 8)
    const isMany = refs.length > 1
    const rowsEach = isMany ? Math.max(config.thumbRows, Math.floor(config.maxRows / 2)) : config.maxRows
    return (
      <Box flexDirection="column">
        {engine}
        <Box paddingLeft={3}>
          {await strip($, el, refs, e.requestId, isMany ? Math.min(room, 48) : room, rowsEach, 'Image')}
        </Box>
      </Box>
    )
  })

  // The lightbox: the picture as large as the pane allows.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const shown = await read($, viewer)
    if (shown === null) return <Text dimColor>No image selected.</Text>
    if (e.surface !== 'terminal') return <Text>{shown.image.path}</Text>
    const room = Math.max(10, e.props.bodyColumns)
    const height = Math.max(4, e.props.scroll.bodyRows - 2)
    const { columns, rows } = fit(shown.image, room, height, true)
    return (
      <Box flexDirection="column">
        {await picture($, el as E, shown.image, columns, rows, 'full')}
        <Text dimColor>
          {shown.image.width}×{shown.image.height} · {shown.image.path} · Esc to close
        </Text>
      </Box>
    )
  })
}
