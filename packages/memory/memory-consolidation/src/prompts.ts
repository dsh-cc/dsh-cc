/**
 * Prompt builders for the extraction and dream forks. Both are pure text
 * assembly so they are unit-testable and stable model-visible contracts.
 *
 * The forks hold no write tools: they report their file set through the
 * driver-injected `structured_output` tool, and the plugin writes the files
 * host-side (see `writeback.ts`). The prompts below are the model-facing half
 * of that contract.
 * @module @dsh-cc/memory-consolidation/prompts
 */

import type { ExtractionWindow } from './extraction-window.ts'
import { MEMORY_AGENT_TOOLS } from './tools.ts'

/** The always-loaded index filename (mirrors `dsh-memory`'s export). */
const ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * Build the <system-reminder> user prompt that extracts durable facts from a
 * batch of recent model-visible messages into structured memory writes.
 * @param surfaceMessageCount - how many model-visible surface events (user/message
 *   + assistant/message + tool/result) this run reviews.
 * @param memoryDir - the memory directory the reported files belong to.
 * @param existingIndex - a prior topic manifest, if any.
 * @returns the prompt text.
 */
export function buildExtractionPrompt(
  surfaceMessageCount: number,
  memoryDir: string,
  existingIndex: string,
): string {
  return [
    `Extract durable memories from the last ${surfaceMessageCount} messages of this conversation and report them via the \`structured_output\` tool.`,
    'A memory is a fact or preference that will be useful in FUTURE conversations, not ephemeral task detail.',
    `Return \`{ "writes": [{ "path", "content" }] }\`: each entry is one file in the memory directory \`${memoryDir}\` — \`path\` is a flat \`.md\` filename (no directories), \`content\` is the complete file body. The plugin writes the files for you; you have no write tools.`,
    'Write each memory to its own `.md` topic file with YAML frontmatter: name, description, and type (`user` | `feedback` | `project` | `reference`).',
    `Add or update a one-line pointer in \`${ENTRYPOINT_NAME}\` for each topic (.md). Do not put memory bodies in the index.`,
    'Never duplicate a topic listed under "Existing topics" below; prefer updating the matching topic file instead of creating a new one (read it first).',
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}. Read only inside \`${memoryDir}\`.`,
    'The conversation to review is already in your context — do not open files or browse directories outside the memory directory.',
    'If the reviewed messages contain no new durable fact worth remembering, return an empty `writes` array and finish immediately.',
    '',
    'Existing topics:',
    existingIndex.length > 0 ? existingIndex : '(none yet)',
    '',
    'FINAL CONTRACT: your turn is incomplete until you have called `structured_output` with the full report. Plans or findings narrated in prose without that call are discarded entirely — there is no partial credit, and no one will ask you twice.',
  ].join('\n')
}

/**
 * Build the <system-reminder> user prompt that extracts durable facts from ONE
 * complete review window (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules").
 *
 * This is the extraction prompt used once the decision gate has captured a
 * reconstructable window: the reviewed material is the explicit `Review window`
 * data section, never "the last N messages" of the live session. Three things
 * must stay true for the skip it protects to be sound:
 *
 * - the window bounds are stated explicitly (`fromExclusive` exclusive,
 *   `throughInclusive` inclusive) so the model never infers the reviewed range;
 * - the watermark is declared HOST state the model cannot advance, extend or
 *   reset — the model reports writes and nothing else;
 * - newer session content is explicitly demoted to context, so a fact that
 *   arrived after the capture is never counted as already reviewed.
 * @param window - the complete review window.
 * @param memoryDir - the memory directory the reported files belong to.
 * @returns the prompt text.
 */
export function buildWindowedExtractionPrompt(window: ExtractionWindow, memoryDir: string): string {
  const from = String(window.fromExclusive)
  const through = String(window.throughInclusive)
  return [
    'Extract durable memories from the review window below and report them via the `structured_output` tool.',
    'A memory is a fact or preference that will be useful in FUTURE conversations, not ephemeral task detail.',
    `Return \`{ "writes": [{ "path", "content" }] }\`: each entry is one file in the memory directory \`${memoryDir}\` — \`path\` is a flat \`.md\` filename (no directories), \`content\` is the complete file body. The plugin writes the files for you; you have no write tools.`,
    'Write each memory to its own `.md` topic file with YAML frontmatter: name, description, and type (`user` | `feedback` | `project` | `reference`).',
    `Add or update a one-line pointer in \`${ENTRYPOINT_NAME}\` for each topic (.md). Do not put memory bodies in the index.`,
    'Never duplicate a topic listed under "Existing topics" below; prefer updating the matching topic file instead of creating a new one (read it first).',
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}. Read only inside \`${memoryDir}\`.`,
    'The conversation to review is already in your context — do not open files or browse directories outside the memory directory.',
    `The review material is the "Review window" section below and nothing else: the host reviewed the session events AFTER seq \`${from}\` and UP TO AND INCLUDING seq \`${through}\`, and that window is the explicit source. Session content outside it — including anything newer — is context only: never extract a fact from it and never treat it as reviewed.`,
    `\`fromExclusive\` and \`throughInclusive\` are the host's review watermark. It is host state: the model cannot advance, extend, reset or otherwise change it, and any reported value for it is ignored.`,
    'If the review window contains no new durable fact worth remembering, return an empty `writes` array and finish immediately.',
    '',
    `Review window (fromExclusive=${from}, throughInclusive=${through}):`,
    ...reviewWindowLines(window),
    '',
    'Existing topics:',
    window.existingIndex.length > 0 ? window.existingIndex : '(none yet)',
    '',
    'FINAL CONTRACT: your turn is incomplete until you have called `structured_output` with the full report. Plans or findings narrated in prose without that call are discarded entirely — there is no partial credit, and no one will ask you twice.',
  ].join('\n')
}

/**
 * Render the window's reviewed events as the prompt's data section: one line
 * per event, in the host's ascending seq order, carrying the original role so
 * an assistant inference is never readable as a user confirmation.
 * @param window - the complete review window.
 * @returns the data-section lines.
 */
function reviewWindowLines(window: ExtractionWindow): string[] {
  if (window.events.length === 0) return ['(the window holds no plain-text evidence)']
  return window.events.map((event) => {
    const role = event.isError === true ? `${event.kind}, tool error` : event.kind
    return `- seq ${String(event.seq)} [${role}]: ${event.text}`
  })
}

/**
 * Build the <system-reminder> user prompt that reviews past sessions and
 * consolidates them into the memory directory, returned as structured writes.
 * @param memoryDir - the memory directory being rewritten.
 * @param sessionsRoot - the real session store root the hint ids live under.
 * @param sessionHints - session ids marking the consolidation window (provenance
 *   hints only; transcripts are zstd-compressed and not readable by the fork).
 * @returns the prompt text.
 */
export function buildConsolidationPrompt(
  memoryDir: string,
  sessionsRoot: string,
  sessionHints: readonly string[],
): string {
  return [
    `You are consolidating persistent memory from past sessions. Distill durable facts and rewrite the memory directory \`${memoryDir}\`.`,
    'The memory directory contains MEMORY.md (an index of topic files) and topic `.md` files with YAML frontmatter (name, description, type).',
    'Return the complete rewritten file set via the `structured_output` tool as `{ "writes": [{ "path", "content" }] }` — flat `.md` filenames with complete bodies. Only the files you return are written; omitted files stay unchanged on disk.',
    'Work in this order:',
    `1. Orient: list \`${memoryDir}\`, then read ${ENTRYPOINT_NAME} and the topic files it points at — that is your primary review material.`,
    '2. Verify against reality: the fork\'s working directory IS the session\'s workspace. Before keeping any load-bearing fact, check it against the current codebase (paths, commands, behavior) with read/grep/glob. On a contradiction between two memories, fix the wrong side. Delete facts referencing things that no longer exist.',
    '3. Normalize dates: convert every relative date ("yesterday", "last week") to the absolute date it referred to.',
    `4. Treat the session hints below as provenance only: they mark which sessions the consolidation window covers. The fork cannot read transcripts (zstd) — never attempt to open or grep them.`,
    `5. Prune and index: rewrite ${ENTRYPOINT_NAME} as one line per topic, targeting under 140 lines (an index over 200 lines / 25 KB is rejected host-side, so stay well under). Move detail into topic files, organized by semantic topic, and keep still-true load-bearing facts.`,
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}.`,
    '',
    `Session provenance hints (ids under \`${sessionsRoot}\`):`,
    ...sessionHints.map(id => `- ${id}`),
    '',
    'FINAL CONTRACT: your turn is incomplete until you have called `structured_output` with the full report. Plans or findings narrated in prose without that call are discarded entirely — there is no partial credit, and no one will ask you twice.',
  ].join('\n')
}
