/**
 * Editor clipboard-image paste: the empty bracketed paste path (an image paste
 * carries no payload), the `[Image #N]` marker grammar, atomic marker editing,
 * and the submit-time image resolution the driver will consume.
 * @module @dsh-cc/tui/editor-image-paste
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@dsh-cc/pi-tui'
import {
  collectReferencedImages,
  formatImageMarker,
  parseImageMarkerIds,
  type PastedImage,
} from '@dsh-cc/pi-tui/src/components/editor.ts'

type EditorHost = ConstructorParameters<typeof Editor>[0]
type EditorThemeArg = ConstructorParameters<typeof Editor>[1]

/**
 * Minimal doubles rather than a full TUI: the editor touches only
 * `terminal.rows` (visible-line budget) and `requestRender()` on the host.
 */
function makeEditor(onPasteImage?: () => Promise<PastedImage | undefined>): Editor {
  const host = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as EditorHost
  const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as EditorThemeArg
  return new Editor(host, theme, onPasteImage ? { onPasteImage } : {})
}

/** An image paste as the terminal delivers it: an empty bracketed paste. */
const EMPTY_PASTE = '\x1b[200~\x1b[201~'

const PNG: PastedImage = { path: '/tmp/dsh-cc-uploads/a.png', mediaType: 'image/png', width: 1552, height: 1012 }
const JPEG: PastedImage = { path: '/tmp/dsh-cc-uploads/b.jpg', mediaType: 'image/jpeg', width: 640, height: 480 }

/** Let the editor's awaiting clipboard frame run to completion. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Reader whose settlement the test controls, to observe the async window. */
function controlledReader(): {
  reader: () => Promise<PastedImage | undefined>
  settle: (image?: PastedImage) => void
  fail: (error: unknown) => void
} {
  let settlePromise!: (image?: PastedImage) => void
  let failPromise!: (error: unknown) => void
  return {
    reader: () =>
      new Promise<PastedImage | undefined>((resolve, reject) => {
        settlePromise = resolve
        failPromise = reject
      }),
    settle: (image) => settlePromise(image),
    fail: (error) => failPromise(error),
  }
}

/** Strip ANSI escape sequences so assertions see plain display text. */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI needs control chars
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

describe('image marker grammar', () => {
  it('renders dimensions when the reader measured the image', () => {
    expect(formatImageMarker(1, { width: 1552, height: 1012 })).toBe('[Image #1 1552x1012]')
  })

  it('drops the dimension suffix when the measurement is missing', () => {
    expect(formatImageMarker(2, { width: 0, height: 0 })).toBe('[Image #2]')
    expect(formatImageMarker(2, { width: 640, height: 0 })).toBe('[Image #2]')
  })

  it('lists marker ids in text order, without repeats', () => {
    expect(parseImageMarkerIds('a [Image #2 10x20] b [Image #1] c [Image #2]')).toEqual([2, 1])
    expect(parseImageMarkerIds('no markers here')).toEqual([])
    expect(parseImageMarkerIds('[paste #1 +12 lines]')).toEqual([])
  })
})

describe('collectReferencedImages', () => {
  it('orders by marker position, not by paste order', () => {
    const images = new Map([
      [1, JPEG],
      [2, PNG],
    ])
    expect(collectReferencedImages('[Image #2] then [Image #1]', images)).toEqual([PNG, JPEG])
  })

  it('drops images whose marker is not in the text', () => {
    const images = new Map([[1, PNG]])
    expect(collectReferencedImages('plain draft', images)).toEqual([])
    expect(collectReferencedImages('recalled [Image #7]', images)).toEqual([])
  })
})

describe('Editor clipboard image paste', () => {
  it('inserts a marker when the injected reader returns an image', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    expect(editor.getText()).toBe('[Image #1 1552x1012]')
    expect(editor.getImages()).toEqual([PNG])
  })

  it('inserts at the cursor and numbers images independently of text pastes', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput('see ')
    editor.handleInput(`\x1b[200~${Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n')}\x1b[201~`)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    expect(editor.getText()).toBe('see [paste #1 +11 lines][Image #1 1552x1012]')
  })

  it('does not read the clipboard for a paste that carries text', async () => {
    let reads = 0
    const editor = makeEditor(async () => {
      reads += 1
      return PNG
    })
    editor.handleInput('\x1b[200~hello\x1b[201~')
    await flush()
    expect(editor.getText()).toBe('hello')
    expect(reads).toBe(0)
    expect(editor.getImages()).toEqual([])
  })

  it('stays silent with no reader configured', async () => {
    const editor = makeEditor()
    editor.handleInput(EMPTY_PASTE)
    await flush()
    expect(editor.getText()).toBe('')
    expect(editor.getImages()).toEqual([])
  })

  it('stays silent when the pasteboard holds no image', async () => {
    const editor = makeEditor(async () => undefined)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    expect(editor.getText()).toBe('')
  })

  it('stays silent and does not leak a rejection when the reader fails', async () => {
    const capture = controlledReader()
    const editor = makeEditor(capture.reader)
    editor.handleInput(EMPTY_PASTE)
    capture.fail(new Error('no pasteboard access'))
    await flush()
    expect(editor.getText()).toBe('')
    expect(editor.getImages()).toEqual([])
  })

  it('stays silent when the reader throws synchronously', async () => {
    const editor = makeEditor(() => {
      throw new Error('unsupported platform')
    })
    expect(() => editor.handleInput(EMPTY_PASTE)).not.toThrow()
    await flush()
    expect(editor.getText()).toBe('')
  })

  it('drops a capture whose draft was replaced before it settled', async () => {
    const capture = controlledReader()
    const editor = makeEditor(capture.reader)
    editor.handleInput(EMPTY_PASTE)
    editor.setText('replacement draft')
    capture.settle(PNG)
    await flush()
    expect(editor.getText()).toBe('replacement draft')
    expect(editor.getImages()).toEqual([])
  })

  it('drops a capture that settles after the draft was submitted', async () => {
    const capture = controlledReader()
    const editor = makeEditor(capture.reader)
    editor.handleInput(EMPTY_PASTE)
    editor.onSubmit = () => {}
    editor.handleInput('\r')
    capture.settle(PNG)
    await flush()
    expect(editor.getText()).toBe('')
    expect(editor.getImages()).toEqual([])
  })

  it('keeps both captures when a second paste lands while the first is reading', async () => {
    const pending: Array<(image?: PastedImage) => void> = []
    const editor = makeEditor(
      () =>
        new Promise<PastedImage | undefined>((resolve) => {
          pending.push(resolve)
        }),
    )
    editor.handleInput(EMPTY_PASTE)
    editor.handleInput(EMPTY_PASTE)
    expect(pending.length).toBe(2)

    // Settle out of paste order: IDs and text order follow settlement, and
    // neither capture is dropped.
    pending[1]!(JPEG)
    pending[0]!(PNG)
    await flush()
    expect(editor.getText()).toBe('[Image #1 640x480][Image #2 1552x1012]')
    expect(editor.getImages()).toEqual([JPEG, PNG])
  })

  it('treats the marker as one unit for cursor movement and backspace', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput('hi ')
    editor.handleInput(EMPTY_PASTE)
    await flush()
    expect(editor.getText()).toBe('hi [Image #1 1552x1012]')

    editor.handleInput('\x1b[D') // left: crosses the whole marker, not one character
    expect(editor.getCursor()).toEqual({ line: 0, col: 3 })

    editor.handleInput('\x1b[C') // right: back across the whole marker
    expect(editor.getCursor()).toEqual({ line: 0, col: 23 })

    editor.handleInput('\x7f') // backspace: removes the marker, not one character
    expect(editor.getText()).toBe('hi ')
    expect(editor.getImages()).toEqual([])
  })

  it('never stops inside the marker for word-wise cursor movement', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput('alpha ')
    editor.handleInput(EMPTY_PASTE)
    await flush()
    // "alpha " is 6 characters, the marker spans 6..26.
    editor.handleInput('\x1bb') // alt+b : one word back, to the marker start
    expect(editor.getCursor()).toEqual({ line: 0, col: 6 })
    editor.handleInput('\x1bf') // alt+f : one word forward, past the whole marker
    expect(editor.getCursor()).toEqual({ line: 0, col: 26 })
  })

  it('removes the whole marker and its image on forward delete', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    editor.handleInput('\x1b[H') // home
    editor.handleInput('\x1b[3~') // delete
    expect(editor.getText()).toBe('')
    expect(editor.getImages()).toEqual([])
  })

  it('undoes the insertion in one step', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput('draft ')
    editor.handleInput(EMPTY_PASTE)
    await flush()
    editor.handleInput('\x1f') // ctrl+- : undo
    expect(editor.getText()).toBe('draft ')
    expect(editor.getImages()).toEqual([])
  })

  it('clears image state on setText, so recalled marker text carries no image', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    editor.setText('[Image #1 1552x1012]')
    expect(editor.getImages()).toEqual([])
  })

  it('keeps image markers literal in getExpandedText, while text pastes still expand', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    const big = Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n')
    editor.handleInput(`\x1b[200~${big}\x1b[201~`)
    expect(editor.getExpandedText()).toBe(`[Image #1 1552x1012]${big}`)
    expect(editor.getImages()).toEqual([PNG])
  })

  it('renders the marker text, never the cache path', async () => {
    const editor = makeEditor(async () => PNG)
    editor.handleInput(EMPTY_PASTE)
    await flush()
    const rendered = editor.render(80).map(stripAnsi).join('\n')
    expect(rendered).toContain('[Image #1 1552x1012]')
    expect(rendered).not.toContain(PNG.path)
  })

  it('reports submission images in marker order inside onSubmit, then releases them', async () => {
    const queue = [PNG, JPEG]
    const editor = makeEditor(async () => queue.shift())
    let submitted: { text: string; images: PastedImage[] } | undefined
    editor.onSubmit = (text) => {
      submitted = { text, images: editor.getImages() }
    }

    editor.handleInput('look: ')
    editor.handleInput(EMPTY_PASTE)
    await flush()
    editor.handleInput(EMPTY_PASTE)
    await flush()
    editor.handleInput('\r')

    expect(submitted).toEqual({ text: 'look: [Image #1 1552x1012][Image #2 640x480]', images: [PNG, JPEG] })
    expect(editor.getImages()).toEqual([])
  })
})
