export type ImageRef = {
  /** sha-256 of the original bytes, hex */
  hash: string
  /** the cached PNG on disk */
  path: string
  width: number
  height: number
}

export type Viewer = { image: ImageRef; title: string } | null

declare module 'claude-code' {
  interface PluginState {
    'inline-images': {
      /** images by transcript row: a prompt's uuid, or a tool call's tool_use_id */
      attached: StateFamily<ImageRef[]>
      /** what the full-size viewer pane shows */
      viewer: Viewer
    }
  }
}
