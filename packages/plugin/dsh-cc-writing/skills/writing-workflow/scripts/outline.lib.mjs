/**
 * Mechanical outline (document-skeleton) computation and replay (design §6).
 *
 * `outline` is a pure function of the after body plus the profile `structure`:
 * the same body yields different outlines under different profiles, so the
 * structure argument is mandatory. Both checks writers compute and inject it;
 * every check-consuming site recomputes it from the afterHash snapshot and
 * compares field by field. Findings are never minted here: outline
 * non-compliance feeds finalize, not the review artifacts.
 */

import { fail } from './files.lib.mjs'
import { scanBlocks } from './markdown.lib.mjs'

const LEADING_HASHES = /^#{1,6}/
const TRAILING_HASHES = /#+$/

/**
 * Heading text for matching: trim, strip the leading ATX hashes, strip any
 * trailing closing hashes, trim again, then lowercase (design §6).
 */
function headingText(line) {
  return line.trim().replace(LEADING_HASHES, '').replace(TRAILING_HASHES, '').trim().toLowerCase()
}

/** `headingHint` alternatives: unconditional `/` split, trim + lowercase. */
function hintAlternatives(headingHint) {
  return headingHint.split('/').map((alternative) => alternative.trim().toLowerCase())
}

/** H2 heading text in document order; setext headings stay prose (v1 limit). */
function h2Texts(afterText) {
  const { blocks } = scanBlocks(afterText)
  const texts = []
  for (const block of blocks) {
    if (block.kind !== 'heading' || block.level !== 2) continue
    texts.push(headingText(afterText.slice(block.start, block.end)))
  }
  return texts
}

/**
 * Compute the outline verdict for one body.
 *
 * Assignment: one H2 per skeleton section, in document order, each heading to
 * the not-yet-matched section with the lowest declaredOrder whose alternatives
 * contain it. A required section with no matching H2 is missing; absent
 * optional sections and headings matching no section are harmless. The matched
 * declaredOrder sequence must strictly increase.
 */
export function computeOutline(structure, afterText) {
  const sections = structure.sections
  const matchedIds = new Set()
  const matched = []
  for (const heading of h2Texts(afterText)) {
    let hit = null
    for (const section of sections) {
      if (matchedIds.has(section.id)) continue
      if (!hintAlternatives(section.headingHint).includes(heading)) continue
      if (hit === null || section.order < hit.order) hit = section
    }
    if (hit === null) continue
    matchedIds.add(hit.id)
    matched.push(hit)
  }
  const missingRequiredSections = sections
    .filter((section) => section.required && !matchedIds.has(section.id))
    .map((section) => section.id)
  const orderViolations = []
  let runningMax = 0
  matched.forEach((section, index) => {
    if (section.order < runningMax) {
      orderViolations.push({ section: section.id, declaredOrder: section.order, actualOrder: index + 1 })
      return
    }
    runningMax = section.order
  })
  const status = missingRequiredSections.length === 0 && orderViolations.length === 0 ? 'compliant' : 'non-compliant'
  return { status, missingRequiredSections, orderViolations }
}

/** Recompute the outline from the after body and compare it field by field. */
export function verifyOutline(check, afterText, structure) {
  const expected = computeOutline(structure, afterText)
  const stored = check.outline
  if (stored === undefined || stored === null) {
    fail('INVALID_INPUT', 'check.outline: the profile declares a structure, so the check carries an outline')
  }
  if (stored.status !== expected.status) {
    fail('INVALID_INPUT', 'check.outline.status: does not match the body recompute', {
      stored: stored.status,
      recomputed: expected.status,
    })
  }
  if (!sameStrings(stored.missingRequiredSections, expected.missingRequiredSections)) {
    fail('INVALID_INPUT', 'check.outline.missingRequiredSections: does not match the body recompute', {
      stored: stored.missingRequiredSections,
      recomputed: expected.missingRequiredSections,
    })
  }
  if (!sameViolations(stored.orderViolations, expected.orderViolations)) {
    fail('INVALID_INPUT', 'check.outline.orderViolations: does not match the body recompute', {
      stored: stored.orderViolations,
      recomputed: expected.orderViolations,
    })
  }
  return expected
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameViolations(left, right) {
  if (left.length !== right.length) return false
  return left.every(
    (value, index) =>
      value.section === right[index].section &&
      value.declaredOrder === right[index].declaredOrder &&
      value.actualOrder === right[index].actualOrder,
  )
}
