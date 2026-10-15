import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A 4x2 PNG's bytes do not matter: the host's ImageMagick is stood in for.
const PNG = 'iVBORw0KGgo' + 'A'.repeat(200)
const READ = {
  type: 'image',
  file: { base64: PNG, type: 'image/png', originalSize: 150 },
}

const run = (stdout: string) => ({
  value: {
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

for (const [term, element] of [
  [{ TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm', HOME: '/home/t' }, 'Raster'],
  [{ TERM: 'xterm-kitty', HOME: '/home/t' }, 'Image'],
] as const) {
  test(`a Read image result draws as ${element}`, async ($, on) => {
    mock.env(on, term)
    on('ui.render', async () => ({ type: 'Text', props: {}, children: ['Read image (150B)'] }))
    on('process.run', async ($, e) => {
      const script = String(e.argv[2])
      // PREPARE prints the size; PIXELS prints RGBA for the asked box.
      if (script.includes('info:')) return run('80 40')
      const columns = Number(e.argv[5])
      const rows = Number(e.argv[6])
      const bytes = new Uint8Array(columns * rows * 4).fill(200)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return run(btoa(bin))
    })
    const ui = await $.ui.mount({
      plugin: 'inline-images',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: 'Read', output: READ, isErrored: false },
    })
    expect((await ui.find({ key: 'toolu_1-pic-0' }))?.type).toBe(element)
    expect(await ui.find({ key: 'toolu_1-view-0' })).toBeDefined()
    await ui.unmount()
  })
}

test('a result with no image is left to the engine', async ($, on) => {
  mock.env(on, { TERM: 'xterm-kitty', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['hi'] }))
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    props: {
      tool_use_id: 'toolu_2',
      tool: 'Bash',
      output: { stdout: 'hi', stderr: '', interrupted: false },
      isErrored: false,
    },
  })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('without ImageMagick the result is the engine’s, with one notice', async ($, on) => {
  mock.env(on, { TERM: 'xterm-256color', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['Read image (150B)'] }))
  const toasts: string[] = []
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () => ({
    value: { exitCode: 3, stdout: '', stderr: 'ImageMagick is not installed', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  for (const id of ['toolu_3', 'toolu_4']) {
    const ui = await $.ui.mount({
      plugin: 'inline-images',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: id,
      props: { tool_use_id: id, tool: 'Read', output: { ...READ, file: { ...READ.file, base64: PNG + id } }, isErrored: false },
    })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    await ui.unmount()
  }
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('ImageMagick')
})

// ImageMagick stood in for: PREPARE prints the size, PIXELS the RGBA asked.
function magick(on: On) {
  on('process.run', async ($, e) => {
    if (String(e.argv[2]).includes('info:')) return run('80 40')
    const bytes = new Uint8Array(Number(e.argv[5]) * Number(e.argv[6]) * 4).fill(200)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return run(btoa(bin))
  })
}

test('a prompt’s attached image is drawn under it', async ($, on) => {
  mock.env(on, { TERM: 'xterm-256color', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['look at this'] }))
  magick(on)
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'person' },
    uuid: '86b73434-8a79-4128-8542-1234567890ab',
    message: {
      type: 'user',
      role: 'user',
      isMeta: false,
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    },
  } as never)
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: '86b73434-8a79-4128-8542-000000000000',
    props: { origin: { kind: 'prompt' } } as never,
  })
  expect((await ui.find({ key: '86b73434-8a79-4128-8542-000000000000-pic-0' }))?.type).toBe('Raster')
  await ui.unmount()
})

test('a folded group of reads shows each image', async ($, on) => {
  mock.env(on, { TERM: 'xterm-256color', HOME: '/home/t' })
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['Read 2 files'] }))
  magick(on)
  const call = (id: string, output: unknown) => ({ tool_use_id: id, tool: 'Read', output, isErrored: false })
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolGroup',
    requestId: 'group-1',
    props: {
      isExpanded: false,
      calls: [
        call('toolu_a', READ),
        call('toolu_b', { type: 'text', file: { content: 'hi' } }),
        call('toolu_c', { ...READ, file: { ...READ.file, base64: PNG + 'B' } }),
      ],
    } as never,
  })
  expect(await ui.findAll({ type: 'Raster' })).toHaveLength(2)
  expect(await ui.find({ key: 'group-1-view-1' })).toBeDefined()
  await ui.unmount()
})
