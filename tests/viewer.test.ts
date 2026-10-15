import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Image bytes whose content does not matter, told apart by a suffix.
const png = (tag: string) => 'iVBORw0KGgo' + 'A'.repeat(200) + tag
// A looping GIF's opening, base64: GIF89a, then a NETSCAPE2.0 extension.
const GIF = btoa('GIF89a\0\0\0\x21\xff\x0bNETSCAPE2.0' + '\0'.repeat(120))

const PANE = {
  plugin: 'inline-images',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'image-viewer',
  props: { bodyColumns: 80, scroll: { bodyRows: 30 } } as never,
} as const

// The engine beneath, ImageMagick stood in for, and what the mod asked of it.
function world(on: On) {
  const asked = { argv: [] as string[][], copied: [] as string[], toasts: [] as string[] }
  mock.env(on, { TERM: 'xterm-256color', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['engine'] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async ($, e) => (asked.toasts.push(e.text), { value: undefined }))
  on('ui.copy', async ($, e) => (asked.copied.push(e.text), { value: { isCopied: true } }))
  on('process.run', async ($, e) => {
    asked.argv.push(e.argv.map(String))
    const script = String(e.argv[2])
    if (script.includes('info:')) return run('80 40')
    if (script.includes('xdg-open')) return run('')
    const bytes = new Uint8Array(Number(e.argv[5]) * Number(e.argv[6]) * 4).fill(200)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return run(btoa(bin))
  })
  return asked
}

// A tool result carrying one image, stored as a session stores it.
function result($: Engine, id: string, data: string) {
  return $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: `row-${id}`,
    message: {
      type: 'user',
      role: 'user',
      isMeta: false,
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
      }],
    },
  } as never)
}

async function openViewer($: Engine, id: string) {
  const row = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Read', output: {}, isErrored: false },
  })
  await row.press({ key: `${id}-view-0` })
  await row.unmount()
}

test('the viewer steps through the session’s images, wrapping', async ($, on) => {
  world(on)
  await result($, 'toolu_1', png('1'))
  await result($, 'toolu_2', png('2'))
  await result($, 'toolu_3', png('3'))
  await openViewer($, 'toolu_1')
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ text: /1 of 3/ }))).toBeDefined()
  await pane.press({ key: 'next' })
  expect((await pane.find({ text: /2 of 3/ }))).toBeDefined()
  expect((await pane.find({ text: /1 of 3/ }))).toBeUndefined()
  await pane.press({ key: 'prev' })
  await pane.press({ key: 'prev' })
  expect((await pane.find({ text: /3 of 3/ }))).toBeDefined()
  await pane.press({ key: 'next' })
  expect((await pane.find({ text: /1 of 3/ }))).toBeDefined()
  await pane.unmount()
})

test('one image: no previous or next', async ($, on) => {
  world(on)
  await result($, 'toolu_1', png('1'))
  await openViewer($, 'toolu_1')
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ key: 'next' })).toBeUndefined()
  expect(await pane.find({ key: 'open' })).toBeDefined()
  await pane.unmount()
})

test('the viewer opens the image elsewhere and copies its path', async ($, on) => {
  const asked = world(on)
  await result($, 'toolu_1', png('1'))
  await openViewer($, 'toolu_1')
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'copy' })
  expect(asked.copied).toHaveLength(1)
  expect(asked.copied[0]).toMatch(/^\/home\/t\/\.cache\/claude-inline-images\/[0-9a-f]{32}\.png$/)
  await pane.press({ key: 'open' })
  const opened = asked.argv.find(argv => argv[2]?.includes('xdg-open'))
  expect(opened?.[4]).toBe(asked.copied[0])
  expect(asked.toasts).toEqual(['Copied the image’s path'])
  await pane.unmount()
})

test('/images draws every image of the session', async ($, on) => {
  world(on)
  await result($, 'toolu_1', png('1'))
  await result($, 'toolu_2', png('2'))
  await result($, 'toolu_2b', png('2'))
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'cmd-1',
    props: { command: 'images', args: '' } as never,
  })
  expect(await ui.findAll({ type: 'Raster' })).toHaveLength(2)
  await ui.unmount()
})

test('an animated image says only its first frame is drawn', async ($, on) => {
  world(on)
  await result($, 'toolu_gif', GIF)
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_gif',
    props: { tool_use_id: 'toolu_gif', tool: 'Read', output: {}, isErrored: false },
  })
  expect(await ui.find({ text: 'animated, first frame' })).toBeDefined()
  await ui.unmount()
})
