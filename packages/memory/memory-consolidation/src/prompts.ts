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
  ].join('\n')
}

/**
 * Build the <system-reminder> user prompt that reviews past sessions and
 * consolidates them into the memory directory, returned as structured writes.
 * @param memoryDir - the memory directory being rewritten.
 * @param transcriptDir - the directory holding past session transcripts.
 * @param sessionHints - a list of session ids to review.
 * @returns the prompt text.
 */
export function buildConsolidationPrompt(
  memoryDir: string,
  transcriptDir: string,
  sessionHints: readonly string[],
): string {
  return [
    `You are consolidating persistent memory from past sessions. Review the sessions listed below (transcripts in \`${transcriptDir}\`), distill durable facts, and rewrite the memory directory \`${memoryDir}\`.`,
    'The memory directory contains MEMORY.md (an index of topic files) and topic `.md` files with YAML frontmatter (name, description, type).',
    'Return the complete rewritten file set via the `structured_output` tool as `{ "writes": [{ "path", "content" }] }` — flat `.md` filenames with complete bodies. Only the files you return are written; omitted files stay unchanged on disk.',
    `Rewrite \`${ENTRYPOINT_NAME}\` to be a concise index (one line per topic) and keep topic files organized by semantic topic, not chronology.`,
    'Remove memories that are wrong or outdated from the index. Do not drop a fact that is still load-bearing.',
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}.`,
    '',
    'Sessions since the last consolidation:',
    ...sessionHints.map(id => `- ${id}`),
  ].join('\n')
}
