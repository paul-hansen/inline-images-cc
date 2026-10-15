# inline-images

A Claude Code mod that shows images inline in the terminal transcript:

- **Pasted images, before you send.** Each `[Image #N]` in your draft is
  previewed above the prompt, with a ✕ that takes it back out.
- **Attachments**, as thumbnails under the prompt they came with.
- **Image tool results** (Read of a PNG, screenshots, MCP images, a PDF's
  pages) under their call, and under a folded "Read 2 files" group.
- **`/image <path>`** draws any image file inline.
- **`/images`** draws every image of the session as thumbnails.
- **A full-size viewer pane** from each image's "⤢ view full size":
  `p` / `n` step through the session's images, `o` opens the image in your
  desktop viewer, `c` copies its path, Esc closes.

## Install

At the prompt of a terminal session:

```
/plugin install inline-images --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick a scope. From a shell:
`claude plugin install inline-images --marketplace <owner>/<repo>`.

## Requirements

- **ImageMagick**, `magick` (v7) or `convert` (v6) on `PATH`: it decodes
  PNG, JPEG, GIF and WebP and scales them. Without it the mod shows a notice
  once and leaves the transcript as it was.
- `sh`, `base64`, `find`; `xdg-open` (Linux) or `open` (macOS) for the
  viewer's open key.

## Terminals

| Terminal | Drawn as |
| --- | --- |
| kitty, Ghostty | real pixels, through the kitty graphics protocol |
| WezTerm, iTerm2, Konsole, Alacritty, foot, ... | truecolor half-blocks (`▀`), two pixels a cell |
| anything inside tmux | half-blocks |

The `renderer` option overrides the guess: `image` always uses kitty
graphics (say, kitty inside a tmux with passthrough on), `halfblock` never
does. Over ssh, kitty graphics still work: the PNG's bytes are sent rather
than its path.

Animated GIFs and WebPs show their first frame, marked "animated, first
frame".

## Options

Set in `/config` (or under `pluginConfigs` in settings):

| Option | Default | |
| --- | --- | --- |
| `renderer` | `auto` | `auto`, `image` or `halfblock`, as above |
| `maxRows` | 20 | tallest a tool-result image may be, in rows |
| `thumbRows` | 8 | height of prompt, draft and `/images` thumbnails |
| `cellAspect` | 2 | a cell's height over its width, for your font |

## Where things live

Decoded images are cached as PNGs under
`$XDG_CACHE_HOME/claude-inline-images` (`~/.cache/...` by default). Files
unused for 30 days, and all but the newest 2000, are removed when a session
starts.

Pasted-image previews read the files Claude Code itself saves for the
session, under `$TMPDIR/claude-<uid>/<project>/<session>/images`. That
folder is not a documented interface, so if a Claude Code update moves it
the band shows "(no preview yet)" and the rest of the mod is unaffected.

## Developing

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` holds the hooks; `hooks/pixels.ts` the pure parts
(base64, half-block packing, sizing, finding images in tool output), which
`tests/pixels.test.ts` covers directly. `types/index.d.ts` declares the
session state. `tsconfig.json` and `.claude-plugin/types/` are written by
Claude Code when it loads the mod from a folder it watches, so they are not
committed.
