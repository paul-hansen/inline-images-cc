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
