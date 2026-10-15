import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'inline-images',
  surface: 'terminal',
  component: 'AbovePrompt',
  // The band's props this mod reads; the rest of the site's are not drawn from.
  props: { hasSurvey: false, maxRows: 20, bodyColumns: 100 } as never,
} as const

// The box changed by something other than a typed edit (a paste, a submit).
function change($: Engine, text: string, kind: 'engine' | 'clear' = 'engine') {
  const prompt = $.prompt as unknown as { change: (e: object) => Promise<unknown> }
  return prompt.change({ text, cursor: 0, origin: { kind } })
}

const PNG = 'iVBORw0KGgo' + 'A'.repeat(200)
const FOLDER = '/tmp/claude-1000/-work-app/sess-1/images'

// The engine beneath: a box that echoes its changes, the session's pasted
// images (when given) in its folder, and ImageMagick stood in for.
function world(on: On, files: string[] = []) {
  mock.env(on, { TERM: 'xterm-256color', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: [''] }))
  on('prompt.change', async ($, e) => ({ text: e.text }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.cwd', async () => ({ value: '/work/app' }))
  on('ui.log', async () => ({ value: undefined }))
  const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }) as const
  const file = (name: string) => ({ name, kind: 'file', size: 300, mtimeMs: 1, isLink: false }) as const
  on('fs.list', async ($, e) => ({
    value: e.path === '/tmp' ? [dir('claude-1000')] : e.path === FOLDER ? files.map(file) : [],
  }))
  on('fs.exists', async ($, e) => ({ value: files.length > 0 && e.path === FOLDER }))
  on('fs.read', async () => ({ value: { base64: PNG } }))
  on('process.run', async ($, e) => {
    const script = String(e.argv[2])
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (script.includes('info:')) return ok('80 40')
    const bytes = new Uint8Array(Number(e.argv[5]) * Number(e.argv[6]) * 4).fill(200)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return ok(btoa(bin))
  })
}

test('the images a draft names show above the prompt', async ($, on) => {
  world(on)
  await change($, '[Image #1] look [Image #2] and [Image #1]')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'draft-1' })).toBeDefined()
  expect(await ui.find({ key: 'draft-2' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  expect(await ui.find({ text: '(no preview yet)' })).toBeDefined()
  await ui.unmount()
})

test('a pasted image in the session folder is previewed', async ($, on) => {
  world(on, ['1.png', '2.jpg'])
  await change($, '[Image #2] what is this')
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'draft-pic-2' }))?.type).toBe('Raster')
  await ui.unmount()
})

test('✕ takes the image out of the draft', async ($, on) => {
  world(on)
  let draft = 'see [Image #1] and [Image #2] here'
  on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', async ($, e) => {
    draft = e.text
    return { isFilled: true }
  })
  await change($, draft)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'draft-remove-1' })
  expect(draft).toBe('see and [Image #2] here')
  expect(await ui.find({ key: 'draft-1' })).toBeUndefined()
  expect(await ui.find({ key: 'draft-2' })).toBeDefined()
  await ui.unmount()
})

test('a submitted or cleared draft takes the band down', async ($, on) => {
  world(on)
  await change($, '[Image #3]')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'draft-3' })).toBeDefined()
  await change($, '', 'clear')
  expect(await ui.find({ key: 'draft-3' })).toBeUndefined()
  await ui.unmount()
})

test('a /clear empties the band', async ($, on) => {
  world(on)
  await change($, '[Image #4]')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'draft-4' })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { sessionId: 'sess-1' } } as never)
  expect(await ui.find({ key: 'draft-4' })).toBeUndefined()
  await ui.unmount()
})
