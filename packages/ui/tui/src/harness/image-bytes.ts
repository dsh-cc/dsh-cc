/**
 * Image bytes without a decoder: the media type from the magic bytes, the pixel
 * size from the header. The clipboard path needs both while the bytes are still
 * in memory, and both are a handful of reads - the repo's other image work is
 * pass-through to the attachment store, which does its own decoding, so a real
 * image library would be a dependency bought for two integer fields.
 *
 * Every parser is header-only and bounds-checked. Anything unrecognised or
 * truncated yields `{ width: 0, height: 0 }` rather than a guess: 0 is the
 * documented "unknown" the caller renders as nothing.
 *
 * @module @dsh-cc/tui/harness/image-bytes
 */

/** The four media types the attachment store accepts for images. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ImageDimensions {
  width: number
  height: number
}

/** Returned when a header cannot be parsed; see the module note on why not a guess. */
const UNKNOWN_DIMENSIONS: ImageDimensions = { width: 0, height: 0 }

/**
 * Byte at `offset`, or 0 past the end. Every parser below length-guards its
 * reads anyway; this exists so those guards can be stated once per format
 * instead of once per field.
 */
function at(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (at(bytes, offset) << 8) | at(bytes, offset + 1)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return at(bytes, offset) | (at(bytes, offset + 1) << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return at(bytes, offset) | (at(bytes, offset + 1) << 8) | (at(bytes, offset + 2) << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((at(bytes, offset) << 24) | (at(bytes, offset + 1) << 16) | (at(bytes, offset + 2) << 8) | at(bytes, offset + 3)) >>> 0
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (at(bytes, offset) | (at(bytes, offset + 1) << 8) | (at(bytes, offset + 2) << 16) | (at(bytes, offset + 3) << 24)) >>> 0
}

/** True when `bytes` carries `expected` verbatim at `offset` (length-guarded). */
function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false
  return expected.every((byte, index) => bytes[offset + index] === byte)
}

/** True when `bytes` carries ASCII `text` at `offset`. */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return matches(bytes, offset, [...text].map(char => char.charCodeAt(0)))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Media type from the leading magic bytes, or `undefined` when the bytes are
 * not one of {@link ImageMediaType}. This is the gate that turns "a helper
 * printed something" into "the pasteboard holds an image": a reader that exits
 * 0 having written an error message or a text clipboard's contents must not be
 * mistaken for image data.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  // PNG: the 8-byte signature plus the mandatory, first IHDR chunk tag. The
  // signature alone also matches a truncated payload, and this gate is what
  // decides whether bytes get spilled to disk at all.
  if (matches(bytes, 0, PNG_SIGNATURE) && asciiAt(bytes, 12, 'IHDR')) return 'image/png'
  // JPEG: SOI marker; the third byte is the first marker's 0xFF.
  if (at(bytes, 0) === 0xff && at(bytes, 1) === 0xd8 && at(bytes, 2) === 0xff) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/** PNG: IHDR is mandatory and first, so the size sits at a fixed offset. */
function pngDimensions(bytes: Uint8Array): ImageDimensions {
  // Signature (8) + chunk length (4) + "IHDR" (4) = width at 16, height at 20.
  // The tag is checked, not assumed: the signature alone also matches a
  // truncated or non-PNG payload, whose "size" bytes are arbitrary.
  if (bytes.length < 24 || !asciiAt(bytes, 12, 'IHDR')) return UNKNOWN_DIMENSIONS
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

/** GIF: the logical screen descriptor follows the 6-byte version header. */
function gifDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 10) return UNKNOWN_DIMENSIONS
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
}

/**
 * JPEG: walk the segment chain to the first Start-Of-Frame, whose payload holds
 * height then width. Segments before it (APPn/EXIF/quantisation tables) are
 * variable-length and must be skipped by their declared length, not searched
 * for a marker pattern - the SOF-looking bytes inside an embedded EXIF
 * thumbnail are a real false positive.
 */
function jpegDimensions(bytes: Uint8Array): ImageDimensions {
  let offset = 2 // past the SOI marker
  while (offset + 9 <= bytes.length) {
    if (at(bytes, offset) !== 0xff) return UNKNOWN_DIMENSIONS
    const marker = at(bytes, offset + 1)
    if (marker === 0xff) {
      offset += 1 // fill byte before a marker
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2 // standalone markers carry no length
      continue
    }
    if (marker === 0xda) return UNKNOWN_DIMENSIONS // entropy-coded data starts; SOF was not seen
    const length = u16be(bytes, offset + 2)
    if (length < 2) return UNKNOWN_DIMENSIONS
    // SOF0-SOF15 are the frame headers, but DHT (0xC4), JPG (0xC8) and DAC
    // (0xCC) share that numeric range without being one.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // FF marker, 2 length bytes, 1 precision byte, then height, then width.
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) }
    }
    offset += 2 + length
  }
  return UNKNOWN_DIMENSIONS
}

/**
 * WebP: RIFF container whose first chunk says which of the three bitstreams
 * follows, each storing the size differently (VP8 as 14-bit fields, VP8L as
 * packed 14-bit fields, VP8X as 24-bit canvas size).
 */
function webpDimensions(bytes: Uint8Array): ImageDimensions {
  const chunk = (offset: number): string =>
    String.fromCharCode(at(bytes, offset), at(bytes, offset + 1), at(bytes, offset + 2), at(bytes, offset + 3))
  const format = chunk(12)
  if (format === 'VP8X') {
    // Extended: flags byte, 3 reserved bytes, then 24-bit canvas width/height MINUS ONE.
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  if (format === 'VP8 ') {
    // Lossy: 3-byte frame tag, the 0x9d012a start code, then width/height in
    // the low 14 bits of a 16-bit field.
    if (at(bytes, 23) !== 0x9d || at(bytes, 24) !== 0x01 || at(bytes, 25) !== 0x2a) return UNKNOWN_DIMENSIONS
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }
  if (format === 'VP8L') {
    // Lossless: 0x2f signature, then 14-bit width-1 and 14-bit height-1 packed
    // little-endian across the next four bytes.
    if (at(bytes, 20) !== 0x2f) return UNKNOWN_DIMENSIONS
    const bits = u32le(bytes, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return UNKNOWN_DIMENSIONS
}

/**
 * Pixel size for `mediaType`, read from the header. `{ width: 0, height: 0 }`
 * when the header is unrecognised, truncated, or declares a zero side.
 */
export function imageDimensions(bytes: Uint8Array, mediaType: ImageMediaType): ImageDimensions {
  const size = mediaType === 'image/png'
    ? pngDimensions(bytes)
    : mediaType === 'image/gif'
      ? gifDimensions(bytes)
      : mediaType === 'image/jpeg'
        ? jpegDimensions(bytes)
        : webpDimensions(bytes)
  if (size.width <= 0 || size.height <= 0) return UNKNOWN_DIMENSIONS
  return size
}
