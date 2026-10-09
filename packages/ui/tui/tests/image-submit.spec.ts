import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { admitSubmitImages, stripImageMarkers, submissionContent, type ImageStoreLike } from '@dsh-cc/tui/harness/image-submit.ts'
import type { PastedImage } from '@dsh-cc/pi-tui'

/**
 * Unit coverage for the submission-side admission helper (plan 3.4/3.6): the
 * marker grammar mirror, the byte -> saveImage -> frozen image-block sequence,
 * and every degradation that must leave the user's prose intact. The
 * driver-level wiring (both dispatch sites, the queued chip, the route gate) is
 * covered in driver-image-submit.spec.ts.
 *
 * The store is a double here, not a reimplementation: it records the inputs and
 * mints one ref per call, the way dsh-attachment's store does.
 */

const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAG0lEQVR4nGNgYDjxPwCIFwAxA0MFkAPEC4AYAJ91DfM4bJ6DAAAAAElFTkSuQmCC',
  'base64',
)

interface StoreDouble {
  store: ImageStoreLike
  calls: { data: Uint8Array; mediaType: string; name?: string }[]
  refs: { attachmentId: string }[]
}

function makeStore(failWith?: string): StoreDouble {
  const calls: StoreDouble['calls'] = []
  const refs: StoreDouble['refs'] = []
  const store: ImageStoreLike = {
    async saveImage(input) {
      calls.push(input)
      if (failWith !== undefined) throw new Error(failWith)
      const ref = { attachmentId: `sha256:${String(refs.length).padStart(64, '0')}` }
      refs.push(ref)
      return ref as never
    },
  }
  return { store, calls, refs }
}

function spilled(dir: string, name: string, bytes: Buffer = PNG_3X2): PastedImage {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, mediaType: 'image/png', width: 3, height: 2 }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-image-submit-'))
}

describe('submissionContent', () => {
  const block = (id: string) => ({ type: 'image' as const, attachment: { attachmentId: id } as never })

  it('is exactly the legacy single text block when nothing was admitted', () => {
    // The regression pin for every image-free prompt, in the shape the composer
    // sent before this feature existed.
    expect(submissionContent({ text: 'plain prompt', blocks: [] })).toEqual([{ type: 'text', text: 'plain prompt' }])
  })

  it('puts the admitted images first, in capture order, then the prose', () => {
    const content = submissionContent({ text: 'what is this', blocks: [block('a'), block('b')] })

    expect(content.map(entry => entry.type)).toEqual(['image', 'image', 'text'])
    expect(content[0]).toEqual(block('a'))
    expect(content[1]).toEqual(block('b'))
    expect(content[2]).toEqual({ type: 'text', text: 'what is this' })
  })

  it('omits the text block for an image-only submission', () => {
    expect(submissionContent({ text: '', blocks: [block('a')] })).toEqual([block('a')])
  })

  it('keeps an empty text block only when there is no image to carry', () => {
    // Unreachable from the composer (an empty draft never submits), pinned so
    // the rule above can never quietly start dropping the text block.
    expect(submissionContent({ text: '', blocks: [] })).toEqual([{ type: 'text', text: '' }])
  })
})

describe('stripImageMarkers', () => {
  it('removes both marker shapes the editor writes', () => {
    expect(stripImageMarkers('look [Image #1 1552x1012]')).toBe('look')
    expect(stripImageMarkers('look [Image #2]')).toBe('look')
  })

  it('consumes one space before each marker, so prose keeps single spaces', () => {
    expect(stripImageMarkers('a [Image #1] b [Image #2 3x2] c')).toBe('a b c')
    // Adjacent markers paste back to back (no separator to consume).
    expect(stripImageMarkers('[Image #1 3x2][Image #2 3x2] after')).toBe('after')
  })

  it('leaves standalone lines empty rather than fusing the lines around a marker', () => {
    // Rejected: a `\s*` sweep would join "before" and "after" into one line,
    // rewriting prose the user typed around the paste.
    expect(stripImageMarkers('before\n[Image #1 3x2]\nafter')).toBe('before\n\nafter')
  })

  it('is a no-op on text with no marker', () => {
    expect(stripImageMarkers('plain prompt')).toBe('plain prompt')
    // Near-misses are prose, not markers: the id must be digits.
    expect(stripImageMarkers('a [Image #x] b')).toBe('a [Image #x] b')
    expect(stripImageMarkers('a [image #1] b')).toBe('a [image #1] b')
  })
})

describe('admitSubmitImages', () => {
  it('admits every image in capture order and returns frozen blocks', async () => {
    const dir = tmpDir()
    const { store, calls, refs } = makeStore()
    const first = spilled(dir, 'a.png')
    const second = spilled(dir, 'b.png', Buffer.concat([PNG_3X2, Buffer.from([0])]))

    const result = await admitSubmitImages(store, 'see [Image #1 3x2] and [Image #2 3x2]', [first, second])

    expect(result.text).toBe('see and')
    expect(result.blocks).toEqual([
      { type: 'image', attachment: refs[0] },
      { type: 'image', attachment: refs[1] },
    ])
    expect(Object.isFrozen(result.blocks)).toBe(true)
    expect(Object.isFrozen(result.blocks[0])).toBe(true)
    // Capture order, one read per image, media type taken from the handle.
    expect(calls.map(call => call.mediaType)).toEqual(['image/png', 'image/png'])
    expect(Buffer.from(calls[1]?.data ?? [])).toEqual(Buffer.concat([PNG_3X2, Buffer.from([0])]))
    expect(result).toMatchObject({ failed: 0, serviceMissing: false })
  })

  it('never passes a name: the spill basename is a digest, not a display name', async () => {
    const dir = tmpDir()
    const { store, calls } = makeStore()

    await admitSubmitImages(store, 'x [Image #1 3x2]', [spilled(dir, 'a.png')])

    // `name` would put the cache file's name (a sha256) into every surface that
    // displays the image; the ref already carries the measured dimensions.
    expect(calls[0]).not.toHaveProperty('name')
  })

  it('a missing attachments service fails every image but keeps the text', async () => {
    const dir = tmpDir()
    const result = await admitSubmitImages(undefined, 'words [Image #1 3x2]', [spilled(dir, 'a.png')])

    expect(result).toMatchObject({ text: 'words', blocks: [], failed: 1, serviceMissing: true })
  })

  it('a refused save is counted and skipped; the remaining images still attach', async () => {
    const dir = tmpDir()
    const { store, calls } = makeStore('attachment store is full')

    const result = await admitSubmitImages(store, 'words [Image #1 3x2][Image #2 3x2]', [
      spilled(dir, 'a.png'),
      spilled(dir, 'b.png'),
    ])

    expect(result.blocks).toEqual([])
    expect(result).toMatchObject({ text: 'words', failed: 2, serviceMissing: false })
    expect(calls).toHaveLength(2)
  })

  it('one refused image of two still admits the other', async () => {
    const dir = tmpDir()
    const { store, calls, refs } = makeStore()
    const ok = spilled(dir, 'a.png')
    const missing: PastedImage = { path: join(dir, 'gone.png'), mediaType: 'image/png', width: 3, height: 2 }

    const result = await admitSubmitImages(store, 'mixed [Image #1 3x2][Image #2 3x2]', [ok, missing])

    expect(result.text).toBe('mixed')
    expect(result.blocks).toEqual([{ type: 'image', attachment: refs[0] }])
    expect(result.failed).toBe(1)
    // The unreadable image never reached the store.
    expect(calls).toHaveLength(1)
  })

  it('an unreadable spill file is a count, never a throw', async () => {
    const dir = tmpDir()
    const { store, calls } = makeStore()
    const missing: PastedImage = { path: join(dir, 'never.png'), mediaType: 'image/png', width: 0, height: 0 }

    await expect(admitSubmitImages(store, 'text [Image #1]', [missing])).resolves
      .toMatchObject({ text: 'text', blocks: [], failed: 1 })
    expect(calls).toEqual([])
  })

  it('an empty image list touches neither the filesystem nor the store', async () => {
    const { store, calls } = makeStore()
    const result = await admitSubmitImages(store, 'text', [])

    expect(result).toMatchObject({ text: 'text', blocks: [], failed: 0, serviceMissing: false })
    expect(calls).toEqual([])
  })

  it('reads the bytes from the spilled path', async () => {
    const dir = tmpDir()
    const { store, calls } = makeStore()
    const spy = vi.fn()

    await admitSubmitImages(store, 'x [Image #1 3x2]', [spilled(dir, 'a.png')])
    spy(calls[0]?.data)
    expect(spy).toHaveBeenCalledOnce()
    expect(Buffer.from(calls[0]?.data ?? [])).toEqual(PNG_3X2)
  })
})
