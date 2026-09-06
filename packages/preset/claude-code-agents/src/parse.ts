/**
 * Parse one Claude Code agent file (`.md` frontmatter + markdown body, or
 * `.json`) into an {@link AgentDefinition}. Every bad known-frontmatter value
 * throws at load time with the file path and the field name, so a broken agent
 * surfaces loud instead of silently degrading; unknown fields are ignored.
 *
 * Discovery reads the file by name, so this module parses from an in-memory
 * string: it stays synchronous, dependency-light, and unit-testable, and the
 * caller owns reading the bytes.
 *
 * @module @dsh-cc/claude-code-agents/parse
 */

import { load as loadYaml } from 'js-yaml'
import { basename, dirname, extname } from 'node:path'
import { normalizeModel, resolveToolRestriction } from './restrict.ts'
import {
  EFFORT_LEVELS,
  ISOLATION_MODES,
  MEMORY_SCOPES,
  PERMISSION_MODES,
} from './types.ts'
import type {
  AgentDefinition,
  AgentSource,
  Effort,
} from './types.ts'

/** A `frontmatter` split out of a raw markdown string. */
export interface ParsedMarkdown {
  /** The YAML metadata block, decoded; empty when the file had none. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  /** The markdown body after the closing `---`, without leading blank lines. */
  readonly content: string
}

/**
 * Split the leading YAML frontmatter block out of a markdown string.
 * A `---`-delimited block at the very start is metadata; anything else (no
 * leading delimiter, or no closing one) means the whole text is body.
 * @param text - the file's full markdown text.
 * @returns the frontmatter record and the trailing body.
 * @throws when the leading block is delimited but not valid YAML.
 */
export function splitFrontmatter(text: string): ParsedMarkdown {
  if (!text.startsWith('---')) return { frontmatter: {}, content: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, content: text.trim() }
  const raw = text.slice(3, end)
  const content = text.slice(end + 4).replace(/^\s*\n/, '').trim()
  let frontmatter: unknown
  try {
    frontmatter = loadYaml(raw)
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (frontmatter === undefined) return { frontmatter: {}, content }
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter) || frontmatter === null) {
    throw new Error('frontmatter must be a YAML object, not a scalar or list')
  }
  return { frontmatter: frontmatter as Readonly<Record<string, unknown>>, content }
}

/**
 * Parse one `.md` agent: the frontmatter supplies the fields and the markdown
 * body (or the `prompt` override) supplies the system prompt.
 * @param filePath - the agent file path; its basename becomes `agentType`.
 * @param text - the full markdown text.
 * @param source - the layer the file was discovered under.
 * @returns the parsed, validated agent definition.
 * @throws when required fields are missing or a known field has a bad value.
 */
export function parseAgentMarkdown(filePath: string, text: string, source: AgentSource): AgentDefinition {
  const agentType = basename(filePath, '.md')
  const { frontmatter, content } = splitFrontmatter(text)
  return buildAgent(filePath, agentType, frontmatter, content, source)
}

/**
 * Parse one `.json` agent: a single object whose keys are frontmatter fields
 * and whose optional `prompt` supplies the system prompt.
 * @param filePath - the agent file path; its basename becomes `agentType`.
 * @param text - the raw JSON text.
 * @param source - the layer the file was discovered under.
 * @returns the parsed, validated agent definition.
 * @throws when JSON is malformed, required fields are missing, or a known field
 *   has a bad value.
 */
export function parseAgentJson(filePath: string, text: string, source: AgentSource): AgentDefinition {
  const agentType = basename(filePath, '.json')
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error(`${filePath}: agent JSON must be an object`)
  }
  const frontmatter = decoded as Readonly<Record<string, unknown>>
  const content = requireString(filePath, 'prompt', frontmatter['prompt'])
  return buildAgent(filePath, agentType, frontmatter, content, source, true)
}

/**
 * Validate required metadata and translate the split frontmatter fields into
 * one {@link AgentDefinition}. The `prompt` key is consumed as the prompt
 * override for `.md` and forwarded through for `.json` via `fromJson`.
 * @param filePath - origin path for errors and the fallback agent name.
 * @param agentType - the resolved agent type name.
 * @param frontmatter - the decoded frontmatter record.
 * @param promptDefault - the markdown body (or the JSON `prompt`, pre-resolved).
 * @param source - the discovery layer.
 * @param promptIsOverride - whether `prompt` was taken from frontmatter.
 * @returns the validated agent definition.
 * @throws on missing description, missing prompt, or any bad known field.
 */
function buildAgent(
  filePath: string,
  agentType: string,
  frontmatter: Readonly<Record<string, unknown>>,
  promptDefault: string,
  source: AgentSource,
  promptIsOverride = false,
): AgentDefinition {
  const whenToUse = requireString(filePath, 'description', frontmatter['description'])
  const display = frontmatter['name']
  if (display !== undefined && typeof display !== 'string') {
    throw new Error(`${filePath}: name must be a string`)
  }
  const tools = optionalToolList(filePath, 'tools', frontmatter['tools'])
  const disallowedTools = optionalToolList(filePath, 'disallowedTools', frontmatter['disallowedTools'])
  const toolRestriction = resolveToolRestriction(tools, disallowedTools)
  const model = normalizeModel(frontmatter['model'])
  const effort = parseEffort(filePath, frontmatter['effort'])
  const permissionMode = parseEnum(filePath, 'permissionMode', frontmatter['permissionMode'], PERMISSION_MODES)
  const maxTurns = parsePositiveInt(filePath, 'maxTurns', frontmatter['maxTurns'])
  const memory = parseEnum(filePath, 'memory', frontmatter['memory'], MEMORY_SCOPES)
  const isolation = parseEnum(filePath, 'isolation', frontmatter['isolation'], ISOLATION_MODES)
  const prompt = promptIsOverride ? undefined : optionalString(filePath, 'prompt', frontmatter['prompt'])
  const initialPrompt = optionalString(filePath, 'initialPrompt', frontmatter['initialPrompt'])
  const background = optionalBoolean(filePath, 'background', frontmatter['background'])
  const systemPrompt = prompt ?? promptDefault

  const definition: Record<string, unknown> = {
    agentType,
    whenToUse,
    systemPrompt,
    source,
    baseDir: dirname(filePath),
    filename: basename(filePath, extname(filePath)),
    ...toolRestriction !== undefined ? { toolRestriction } : {},
  }
  addOptional(definition, 'skills', optionalStringArray(filePath, 'skills', frontmatter['skills']))
  addOptional(definition, 'mcpServers', optionalStringArray(filePath, 'mcpServers', frontmatter['mcpServers']))
  addOptional(definition, 'hooks', optionalRecordArray(filePath, 'hooks', frontmatter['hooks']))
  addOptional(definition, 'model', model)
  addOptional(definition, 'effort', effort)
  addOptional(definition, 'permissionMode', permissionMode)
  addOptional(definition, 'maxTurns', maxTurns)
  addOptional(definition, 'initialPrompt', initialPrompt)
  addOptional(definition, 'background', background)
  addOptional(definition, 'memory', memory)
  addOptional(definition, 'isolation', isolation)
  return definition as unknown as AgentDefinition
}

/** Assign `value` onto `target[key]` unless it is undefined. */
function addOptional<K extends keyof AgentDefinition>(
  target: Record<string, unknown>,
  key: K,
  value: AgentDefinition[K] | undefined,
): void {
  if (value !== undefined) target[key] = value
}

// ── field readers ───────────────────────────────────────────────────────────

/** Read a required string field, throwing with the file path when absent. */
function requireString(filePath: string, key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${filePath}: missing required "${key}" (a non-empty string)`)
  }
  return value
}

/** Read an optional string field. */
function optionalString(filePath: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${filePath}: ${key} must be a non-empty string`)
  }
  return value
}

/** Read an optional boolean field. */
function optionalBoolean(filePath: string, key: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${filePath}: ${key} must be a boolean`)
  }
  return value
}

/** Read an optional array of strings. */
function optionalStringArray(filePath: string, key: string, value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`${filePath}: ${key} must be an array of strings`)
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${filePath}: ${key} must name strings, got ${String(item)}`)
    }
  }
  return value as readonly string[]
}

/**
 * Read an optional tool list: a comma-separated string (Claude Code's
 * frontmatter shorthand, e.g. `tools: Bash, Read`) or an array of strings.
 * String entries are split on commas and trimmed; empty entries are dropped.
 */
function optionalToolList(filePath: string, key: string, value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0)
  }
  return optionalStringArray(filePath, key, value)
}

/** Read an optional record of arbitrary values (hooks). */
function optionalRecordArray(filePath: string, key: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${filePath}: ${key} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Read an optional positive integer (maxTurns). */
function parsePositiveInt(filePath: string, key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${filePath}: ${key} must be a positive integer`)
  }
  return value
}

/** Read an optional effort: a named level or a positive integer. */
function parseEffort(filePath: string, value: unknown): Effort | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as Effort
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  throw new Error(`${filePath}: effort must be one of ${EFFORT_LEVELS.join(', ')} or a positive integer`)
}

/** Read an optional enum value from a closed tuple. */
function parseEnum<T extends string>(
  filePath: string,
  key: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${filePath}: ${key} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}
