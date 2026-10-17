import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ImageRef } from '../types'
import { draftImages, fit as fitCells, fromBase64, imagesIn, installCommand, isAnimated, pack, withoutImage } from './pixels'
import type { Raw } from './pixels'

const PANE = 'image-viewer'
const ATTACHED = { plugin: 'inline-images', key: 'attached' } as const
const viewer = atom({ plugin: 'inline-images', key: 'viewer' } as const, null)
const PENDING = { plugin: 'inline-images', key: 'pending' } as const
const pending = atom(PENDING, [] as number[])
const GALLERY = { plugin: 'inline-images', key: 'gallery' } as const
const gallery = atom(GALLERY, [] as ImageRef[])
const GALLERY_SIZE = 500

type E = Elements['terminal']
type Mode = 'image' | 'halfblock'
type Config = { renderer: string; maxRows: number; thumbRows: number; cellAspect: number }

// Decodes any image ImageMagick reads (png, jpeg, gif, webp) from base64 on
// stdin to a PNG cached under its hash, then prints its size. Without
// ImageMagick it prints the OS and the package managers on PATH instead.
const PREPARE = `
M=$(command -v magick || command -v convert) || {
  echo "ImageMagick is not installed" >&2
  uname -s
  for p in brew port apt-get dnf yum pacman zypper apk xbps-install emerge pkg nix-env winget scoop choco; do
    command -v "$p" >/dev/null 2>&1 && echo "$p"
  done
  exit 3
}
mkdir -p "$1"
f="$1/$2.png"
if [ -s "$f" ]; then cat >/dev/null; touch "$f"; else
  base64 -d | "$M" '-[0]' -auto-orient -resize '2048x2048>' "png:$f.tmp" && mv "$f.tmp" "$f" || exit 4
fi
"$M" "$f" -format '%w %h' info:
`

// Scales a cached PNG to exactly cols x rows pixels and prints them as RGBA, base64.
const PIXELS = `
M=$(command -v magick || command -v convert) || exit 3
"$M" "$1" -background none -resize "$2x$3!" -depth 8 rgba:- | base64 | tr -d '\\n'
`

// Drops cached PNGs unused for $2 days, then all but the newest $3.
const PRUNE = `
cd "$1" 2>/dev/null || exit 0
find . -maxdepth 1 -name '*.png*' -mtime +"$2" -exec rm -f {} +
ls -1t | grep '\\.png$' | tail -n +"$3" | while IFS= read -r f; do rm -f -- "$f"; done
`
// Opens a file in the desktop's own viewer, let go of at once.
const OPEN = `
if command -v xdg-open >/dev/null 2>&1; then ( xdg-open "$1" </dev/null >/dev/null 2>&1 & )
elif command -v open >/dev/null 2>&1; then open "$1"
else echo "found neither xdg-open nor open" >&2; exit 3; fi
`

const KEEP_DAYS = 30
const KEEP_FILES = 2000

let config: Config = { renderer: 'auto', maxRows: 20, thumbRows: 8, cellAspect: 2 }
const prepared = new Map<string, Promise<ImageRef | null>>()
const rasters = new Map<string, Promise<string | null>>()
const remote = new Map<string, Promise<string>>()
let isMagickMissingShown = false

// A cache of jobs that keeps its newest `size`, a failed job not kept.
function cached<T>(jobs: Map<string, Promise<T>>, id: string, size: number, start: () => Promise<T>, isFailed: (v: T) => boolean) {
  let job = jobs.get(id)
  if (job === undefined) {
    job = start()
    jobs.set(id, job)
    job.then(value => isFailed(value) && jobs.delete(id), () => jobs.delete(id))
    if (jobs.size > size) jobs.delete(jobs.keys().next().value!)
  }
  return job
}

// A number option as given, or its default when it is not one in range.
function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
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

async function decode($: EngineInterface, raw: Raw, hash: string, isMoving: boolean): Promise<ImageRef | null> {
  const folder = await dir($)
  const ran = await $.process.run(['sh', '-c', PREPARE, 'sh', folder, hash], {
    stdin: raw.data,
    timeoutMs: 20_000,
  })
  if (ran.exitCode === 3) {
    if (!isMagickMissingShown) {
      isMagickMissingShown = true
      const [os = '', ...managers] = ran.stdout.trim().split('\n')
      const command = installCommand(os, managers)
      const how = command === null ? 'see https://imagemagick.org/download/' : `install it with: ${command}`
      $.ui.toast(`inline-images needs ImageMagick to draw images; ${how}`, { timeoutMs: 15_000 })
    }
    return null
  }
  const [width = 0, height = 0] = ran.stdout.trim().split(' ').map(Number)
  if (ran.exitCode !== 0 || !(width > 0 && height > 0)) {
    $.ui.log(`inline-images: ${ran.stderr.trim() || 'could not decode an image'}`, { to: 'debug' })
    return null
  }
  const ref: ImageRef = { hash, path: `${folder}/${hash}.png`, width, height }
  return isMoving ? { ...ref, isAnimated: true } : ref
}

async function prepare($: EngineInterface, raw: Raw): Promise<ImageRef | null> {
  const bytes = fromBase64(raw.data)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hash = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
  const job = () => decode($, raw, hash, isAnimated(bytes)).catch(() => null)
  return cached(prepared, hash, 500, job, ref => ref === null)
}

async function prepareAll($: EngineInterface, raws: Raw[]): Promise<ImageRef[]> {
  const refs = await Promise.all(raws.map(raw => prepare($, raw)))
  return refs.filter(ref => ref !== null)
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
  return cached(rasters, id, 200, () => scale($, ref, columns, rows).catch(() => null), cells => cells === null)
}

function fit(ref: ImageRef, maxColumns: number, maxRows: number, isUpscaled = false) {
  return fitCells(ref, maxColumns, maxRows, config.cellAspect, isUpscaled)
}

async function picture(
  $: EngineInterface, el: E, ref: ImageRef, columns: number, rows: number, key: string,
): Promise<RenderElement> {
  const { Image, Raster, Text } = el
  const alt = `[image ${ref.width}×${ref.height}]`
  if ((await detectMode($)) === 'image') {
    const isRemote = Boolean(await $.env.get('SSH_CONNECTION'))
    // Over ssh the terminal cannot read this machine's files: send the bytes.
    const source = isRemote
      ? { png: await cached(remote, ref.hash, 20, async () => (await $.fs.read(ref.path, { as: 'bytes' })).base64, () => false) }
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
  const { Box, Text } = el
  const items = await Promise.all(
    refs.map(async (ref, i) => {
      const { columns, rows } = fit(ref, room, rowsEach)
      return (
        <Box key={`${site}-${i}`} flexDirection="column" width={Math.max(columns, 17)}>
          {await picture($, el, ref, columns, rows, `${site}-pic-${i}`)}
          {ref.isAnimated ? <Text dimColor>animated, first frame</Text> : null}
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

// Every image the session showed, oldest first, for the viewer to step through.
async function remember($: EngineInterface, refs: ImageRef[]) {
  await update($, gallery, was => {
    const fresh = refs.filter(ref => !was.some(old => old.hash === ref.hash))
    return fresh.length === 0 ? was : [...was, ...fresh].slice(-GALLERY_SIZE)
  })
}

// The viewer moves `by` images through the gallery, wrapping at its ends.
async function step($: EngineInterface, by: number) {
  const all = (await $.state.get(GALLERY)).value ?? []
  await update($, viewer, was => {
    if (was === null || all.length === 0) return was
    const at = all.findIndex(ref => ref.hash === was.image.hash)
    const next = all[(((at < 0 ? 0 : at + by) % all.length) + all.length) % all.length]!
    return { ...was, image: next }
  })
}

async function openExternally($: EngineInterface, path: string) {
  const ran = await $.process.run(['sh', '-c', OPEN, 'sh', path], { timeoutMs: 5_000 }).catch(() => null)
  if (ran === null || ran.exitCode !== 0) $.ui.toast(`Could not open ${path}: ${ran?.stderr.trim() || 'the opener failed'}`)
}

async function copyPath($: EngineInterface, path: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? 'Copied the image’s path' : `Could not copy the path (${copied.reason})`)
}

let pastedDir: Promise<string | null> | undefined
let isPastedDirMissingLogged = false
const pasted = new Map<string, Promise<ImageRef | null>>()
const PASTED_NAME = /^(\d+)\.(png|jpe?g|gif|webp)$/i

// Where Claude Code saves this session's pasted images, as N.png:
// <tmp>/claude-<uid>/<project>/<session id>/images, <project> being the
// working directory with every other character than [A-Za-z0-9] a dash.
// Not a documented place, so the project folder is searched for too.
async function findPastedDir($: EngineInterface): Promise<string | null> {
  const sid = await $.session.id()
  const project = (await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')
  const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')
  const roots = [...new Set([tmp, '/tmp'].filter(root => root !== ''))]
  const users = async (root: string) =>
    (await $.fs.list(root).catch(() => [])).filter(d => d.kind === 'dir' && d.name.startsWith('claude-'))
  for (const root of roots) {
    for (const user of await users(root)) {
      const guess = `${root}/${user.name}/${project}/${sid}/images`
      if (await $.fs.exists(guess)) return guess
    }
  }
  for (const root of roots) {
    for (const user of await users(root)) {
      for (const dir of await $.fs.list(`${root}/${user.name}`).catch(() => [])) {
        const folder = `${root}/${user.name}/${dir.name}/${sid}/images`
        if (dir.kind === 'dir' && (await $.fs.exists(folder))) return folder
      }
    }
  }
  return null
}

function pastedImagesDir($: EngineInterface): Promise<string | null> {
  pastedDir ??= findPastedDir($).catch(() => null).then(found => {
    if (found === null) {
      pastedDir = undefined
      if (!isPastedDirMissingLogged) {
        isPastedDirMissingLogged = true
        $.ui.log('inline-images: found no folder of pasted images for this session', { to: 'debug' })
      }
    }
    return found
  })
  return pastedDir
}

async function syncPending($: EngineInterface, text: string) {
  const now = draftImages(text)
  const before = (await $.state.get(PENDING)).value ?? []
  if (before.length === now.length && before.every((n, i) => n === now[i])) return
  await update($, pending, () => now)
}

// A pasted image's preview, read again only when its file changes.
async function pastedImage($: EngineInterface, n: number): Promise<ImageRef | null> {
  const folder = await pastedImagesDir($)
  if (folder === null) return null
  const entries = await $.fs.list(folder).catch(() => [])
  const file = entries.find(f => f.kind === 'file' && Number(PASTED_NAME.exec(f.name)?.[1]) === n)
  if (file === undefined) return null
  const id = `${folder}/${file.name}:${file.mtimeMs}:${file.size}`
  const read = () => $.fs.read(`${folder}/${file.name}`, { as: 'bytes' }).then(({ base64 }) => prepare($, { data: base64 }))
  return cached(pasted, id, 50, () => read().catch(() => null), ref => ref === null)
}

async function removeFromDraft($: EngineInterface, n: number) {
  const box = await $.prompt.read()
  const text = withoutImage(box.text, n)
  await $.prompt.fill({ text, mode: 'replace' })
  await syncPending($, text)
}

// The draft's images over the prompt, each with a ✕ in its top-right corner.
async function draftStrip($: EngineInterface, el: E, numbers: number[], rowsEach: number, room: number) {
  const { Box, Button, Text } = el
  const items = await Promise.all(
    numbers.map(async n => {
      const ref = await pastedImage($, n)
      const { columns, rows } = ref === null ? { columns: 16, rows: 1 } : fit(ref, Math.min(room, 32), rowsEach)
      const width = Math.max(columns, 14)
      return (
        <Box key={`draft-${n}`} flexDirection="column" width={width}>
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text dimColor>Image #{n}</Text>
            <Button key={`draft-remove-${n}`} plain label="✕" onPress={() => removeFromDraft($, n)} />
          </Box>
          {ref === null
            ? <Text dimColor>(no preview yet)</Text>
            : await picture($, el, ref, columns, rows, `draft-pic-${n}`)}
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

async function fileImage($: EngineInterface, path: string): Promise<ImageRef | null> {
  try {
    return await prepare($, { data: (await $.fs.read(path, { as: 'bytes' })).base64 })
  } catch {
    return null
  }
}

async function attachedFor($: EngineInterface, id: string): Promise<ImageRef[]> {
  return (await $.state.get({ ...ATTACHED, id })).value ?? []
}

async function toolImages($: EngineInterface, id: string | undefined, output: unknown) {
  const stored = id === undefined ? [] : await attachedFor($, id)
  return stored.length > 0 ? stored : prepareAll($, imagesIn(output))
}

export const register: Register = (on, options) => {
  config = {
    renderer: String(options.renderer ?? 'auto'),
    maxRows: Math.round(num(options.maxRows, 20, 2, 200)),
    thumbRows: Math.round(num(options.thumbRows, 8, 2, 100)),
    cellAspect: num(options.cellAspect, 2, 0.5, 4),
  }
  mode = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'image',
      description: 'Show an image file inline in the transcript',
      argumentHint: '<path>',
    })
    await $.command.register({
      name: 'images',
      description: 'Show every image of this session as thumbnails',
    })
    // Keep the PNG cache from growing without end; off the start's path.
    void dir($)
      .then(folder => $.process.run(['sh', '-c', PRUNE, 'sh', folder, String(KEEP_DAYS), String(KEEP_FILES + 1)]))
      .catch(() => {})
    return next(e)
  })

  // Track which pasted images the draft holds, for the preview band: typed
  // edits come by prompt.edit, everything else (a paste of an image, a
  // submit or clear, history, undo) by prompt.change.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await syncPending($, box.text)
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    await syncPending($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear goes on under a new session id, with its own pasted images.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      pastedDir = undefined
      await update($, pending, () => [])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Pasted images waiting in the draft, above the prompt box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const numbers = await read($, pending)
    if (numbers.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const rowsEach = Math.max(2, Math.min(config.thumbRows, e.props.maxRows - 2))
    return draftStrip($, el, numbers, rowsEach, e.props.bodyColumns - 2)
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
      if (refs.length > 0) {
        await $.state.set({ ...ATTACHED, id }, refs)
        await remember($, refs)
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'image' }, async ($, e) => {
    const path = e.args.trim()
    if (path === '') return { text: 'Usage: /image <path>' }
    const ref = await fileImage($, path)
    if (ref !== null) await remember($, [ref])
    return { text: ref === null ? `Could not read an image at ${path}` : `Image: ${path}` }
  })

  on('command.run', { command: 'images' }, async $ => {
    const count = (await $.state.get(GALLERY)).value?.length ?? 0
    return { text: count === 0 ? 'No images in this session yet.' : `${count} image${count === 1 ? '' : 's'} in this session` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'images' } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const engine = await next(e)
    const refs = await read($, gallery)
    if (refs.length === 0) return engine
    const el = $.ui.resolve(e)
    const { Box } = el
    return (
      <Box flexDirection="column">
        {engine}
        {await strip($, el, refs, e.requestId, 32, config.thumbRows, 'Image')}
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'image' } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const engine = await next(e)
    const path = e.props.args.trim()
    if (path === '') return engine
    const ref = await fileImage($, path)
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

  // Attachments under the prompt they came with, as thumbnails.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind === 'task-notification') return next(e)
    const refs = await attachedFor($, promptKey(e.requestId))
    if (refs.length === 0) return next(e)
    const engine = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    return (
      <Box flexDirection="column">
        {engine}
        <Box paddingLeft={2}>
          {await strip($, el, refs, e.requestId, 32, config.thumbRows, 'Attached image')}
        </Box>
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
  // The lightbox: the picture as large as the pane allows, and the keys to
  // step through the session's images, open one elsewhere or copy its path.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    const shown = await read($, viewer)
    if (shown === null) return <Text dimColor>No image selected.</Text>
    if (e.surface !== 'terminal') return <Text>{shown.image.path}</Text>
    const all = await read($, gallery)
    const at = all.findIndex(ref => ref.hash === shown.image.hash)
    const image = shown.image
    const room = Math.max(10, e.props.bodyColumns)
    const height = Math.max(4, e.props.scroll.bodyRows - 3)
    const { columns, rows } = fit(image, room, height, true)
    const facts = [
      at < 0 ? null : `${at + 1} of ${all.length}`,
      `${image.width}×${image.height}`,
      image.isAnimated ? 'animated, first frame' : null,
      image.path,
    ].filter(fact => fact !== null)
    return (
      <Box flexDirection="column">
        {await picture($, el as E, image, columns, rows, 'full')}
        <Text dimColor>{facts.join(' · ')}</Text>
        <Box flexDirection="row" columnGap={2}>
          {all.length > 1 ? <Button key="prev" plain hotkey="p" label="previous" onPress={() => step($, -1)} /> : null}
          {all.length > 1 ? <Button key="next" plain hotkey="n" label="next" onPress={() => step($, 1)} /> : null}
          <Button key="open" plain hotkey="o" label="open" onPress={() => openExternally($, image.path)} />
          <Button key="copy" plain hotkey="c" label="copy path" onPress={press => copyPath($, image.path, press.surface)} />
          <Text dimColor>Esc to close</Text>
        </Box>
      </Box>
    )
  })
}
