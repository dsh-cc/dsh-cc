/**
 * Submission-side image admission: turn the clipboard files the editor spilled
 * at paste time into durable attachment references plus a message-content block
 * list, and keep the composer's `[Image #N]` markers out of the prompt prose.
 *
 * Mirrors the canonical sequence in `admitCommandAttachments`
 * (dsh-commands/lib/types/index.js:424): bytes -> `saveImage` -> frozen
 * `{ type: 'image', attachment: ref }` blocks in caller order. A reference is
 * never built by hand - the attachment provider verifies the digest of the
 * stored bytes when it reads one back, so a synthetic ref fails the turn deep
 * in provider request assembly instead of here.
 *
 * Nothing in this module throws. Every failure degrades to "that image did not
 * make it", counted for the caller's notice, with the prose preserved (plan
 * 3.6): a paste must never cost the user their typed text.
 *
 * WHY the text is stripped here rather than in the composer or at paste time:
 * the marker is the only honest handle the composer has (plan 3.2), and the
 * driver is the first place that knows whether an image was actually attached.
 * Stripping is therefore part of admission, and every marker goes - including
 * one whose image failed - because a surviving marker reaches the model as
 * prose naming an image it never received.
 *
 * @module @dsh-cc/tui/harness/image-submit
 */

import { readFile } from 'node:fs/promises'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { PastedImage } from '@dsh-cc/pi-tui'

/** The raster formats the attachment path accepts; the editor's own union. */
export type SubmitImageMediaType = PastedImage['mediaType']

/**
 * Structural seam for the mounted `attachments` service (dsh-attachment's
 * AttachmentStore). Declared locally, like every other `*Like` seam in this
 * package: the tui package does not depend on the attachment package, and only
 * `saveImage` is used. The return type is the block's own attachment type, so
 * the block below is built from the provider's verified ref rather than from a
 * second, drift-prone declaration of it.
 */
export interface ImageStoreLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: SubmitImageMediaType
    name?: string
  }): Promise<ImageBlock['attachment']>
}

/** What one submission's captured images contributed to the outgoing message. */
export interface SubmitImageAdmission {
  /**
   * The outgoing prose: every image marker removed. Empty when the submission
   * was an image with no words around it - the caller then omits the text block
   * rather than sending one that says nothing.
   */
  readonly text: string
  /** Admitted image blocks, in capture order; empty when nothing was admitted. */
  readonly blocks: readonly ImageBlock[]
  /** Captured images that did not make it (unreadable spill file, refused save). */
  readonly failed: number
  /** True when no `attachments` service is mounted at all - a distinct notice. */
  readonly serviceMissing: boolean
}

/**
 * One submission on its way to message assembly: the outgoing prose plus the
 * image blocks admitted for it. Declared here rather than in the driver so the
 * content-shape rule below can be tested without a harness.
 */
export interface SubmissionPayload {
  readonly text: string
  readonly blocks: readonly ImageBlock[]
}

/**
 * The content blocks for one submission: the prose alone when nothing was
 * admitted - byte-identical to the pre-image message, which is the regression
 * the whole feature has to keep - otherwise the images in capture order first
 * and the prose after them (plan 3.4).
 *
 * An image-only submission carries NO text block at all: an empty block is
 * noise the provider would drop, and the transcript fold keys its user row on
 * text, so a blank block would surface nothing anyway.
 */
export function submissionContent(submission: SubmissionPayload): readonly ContentBlock[] {
  if (submission.blocks.length === 0) return [Object.freeze({ type: 'text', text: submission.text })]
  if (submission.text.length === 0) return Object.freeze([...submission.blocks])
  return Object.freeze([...submission.blocks, Object.freeze({ type: 'text', text: submission.text })])
}

/**
 * The composer's image-marker grammar, mirrored from pi-tui's editor.ts
 * (IMAGE_MARKER_REGEX). That regex is module-private and the pi-tui barrel
 * exports only the `PastedImage` type, so this package cannot import the
 * grammar; `formatImageMarker` is the writer this reads, and the two must move
 * together.
 *
 * The leading `[ \t]?` is consumed with the marker so `see [Image #1] this`
 * keeps single spaces instead of gaining a double one. Deliberately not `\s*`
 * and no interior reflow: a marker alone on its line leaves that line empty
 * rather than fusing the lines around it, which would rewrite prose the user
 * typed around the paste.
 */
const IMAGE_MARKER = /[ \t]?\[Image #\d+(?: \d+x\d+)?\]/g

/**
 * Remove every image marker from `text`. Only called for a submission that
 * carried at least one captured image, so an image-free prompt keeps the exact
 * text it had before this feature existed.
 */
export function stripImageMarkers(text: string): string {
  // Trimmed because the marker can be the first or last token: the composer
  // trimmed the submission to begin with, so this restores that shape rather
  // than introducing one.
  return text.replace(IMAGE_MARKER, '').trim()
}

/**
 * Admit every captured image in capture order, and report the outgoing text.
 *
 * The attachment service owns validation - byte-level media-type check, size,
 * pixel and count limits, normalization - and throws on refusal, so one bad
 * paste must not take the others, or the prompt, down with it: a failed image
 * is counted and skipped, and the rest still attach.
 *
 * No `name` is passed: the spilled basename is a content digest, and the ref
 * already carries the measured dimensions, so a name would only repeat one of
 * them into every surface that displays the image.
 */
export async function admitSubmitImages(
  store: ImageStoreLike | undefined,
  text: string,
  images: readonly PastedImage[],
): Promise<SubmitImageAdmission> {
  const stripped = stripImageMarkers(text)
  if (store === undefined) {
    return { text: stripped, blocks: [], failed: images.length, serviceMissing: true }
  }
  const blocks: ImageBlock[] = []
  let failed = 0
  for (const image of images) {
    let data: Uint8Array
    try {
      data = await readFile(image.path)
    } catch {
      failed += 1
      continue
    }
    try {
      const ref = await store.saveImage({ data, mediaType: image.mediaType })
      // Frozen per block, as the canonical caller does; the message factory
      // deep-freezes the whole message again on the way out.
      blocks.push(Object.freeze({ type: 'image', attachment: ref }))
    } catch {
      failed += 1
    }
  }
  return { text: stripped, blocks: Object.freeze(blocks), failed, serviceMissing: false }
}
