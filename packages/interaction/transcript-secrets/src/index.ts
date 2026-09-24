/**
 * Transcript secret redaction (plan C2): one-way string→string scrubbing of
 * pasted credentials at export/store boundaries. Pure module — no network, no
 * settings read at match time (settings are read by callers via
 * {@link readSecretsSettings} and passed in as `extraPatterns`).
 * @module @dsh-cc/transcript-secrets
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** Replacement marker written in place of each redacted match. */
const REDACTED = '[REDACTED]'

/**
 * Built-in credential patterns, in match order (longest prefix first so
 * `sk-ant-` is not eaten by the OpenAI pattern); each has a ≥20-character
 * body floor baked into the quantifier, except the fixed-shape AWS keys.
 */
const BUILT_IN_PATTERNS: readonly { name: string; source: string }[] = [
  { name: 'anthropic', source: 'sk-ant-[A-Za-z0-9_-]{20,}' },
  { name: 'openai', source: 'sk-(?:proj-)?[A-Za-z0-9_-]{20,}' },
  { name: 'github', source: 'gh[pousr]_[A-Za-z0-9]{20,}' },
  { name: 'aws', source: '(?:AKIA|ASIA)[0-9A-Z]{16}' },
  { name: 'bearer', source: 'Bearer\\s+[A-Za-z0-9._~+/=-]{20,}' },
]

/**
 * Env-var NAME suffix match; values of matched names with fewer than
 * {@link ENV_VALUE_FLOOR} characters are never redacted.
 */
const ENV_NAME_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIALS?|PRIVATE|OAUTH)$/u

/** Minimum env VALUE length before a value is treated as a secret. */
const ENV_VALUE_FLOOR = 8

/** Logger injected by callers; defaults to no-op (redaction never logs loudly). */
export type LogFn = (message: string) => void

/** Options for {@link redact}. */
export interface RedactOptions {
  /** Caller-supplied regex SOURCE strings compiled per unique source (cached). */
  readonly extraPatterns?: readonly string[]
  /** Log sink for invalid extra patterns; default no-op. */
  readonly log?: LogFn
}

/** Result of {@link redact}: counts and env names only, never values. */
export interface RedactResult {
  /** The redacted text. */
  readonly text: string
  /** Total number of redacted matches. */
  readonly matches: number
  /** Env-var NAMES whose values were redacted (never values). */
  readonly envNames: readonly string[]
}

// Module-level lazy-once env snapshot: captured on the first `redact()` call
// in the host process; never re-read at export/store time.
let envSnapshot: Map<string, string> | undefined

// extraPatterns compiled per unique source; hot-reloaded settings take effect
// without re-boot because new sources compile on first use.
const extraCache = new Map<string, RegExp | undefined>()

/** Reset module caches (env snapshot + extra-pattern compile cache). Tests only. */
export function resetForTests(): void {
  envSnapshot = undefined
  extraCache.clear()
}

function getEnvSnapshot(): Map<string, string> {
  if (envSnapshot !== undefined) return envSnapshot
  const snapshot = new Map<string, string>()
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value.length < ENV_VALUE_FLOOR) continue
    if (!ENV_NAME_RE.test(name)) continue
    snapshot.set(name, value)
  }
  envSnapshot = snapshot
  return snapshot
}

function compileExtra(source: string, log: LogFn): RegExp | undefined {
  const hit = extraCache.get(source)
  if (hit !== undefined) return hit === null ? undefined : hit
  let compiled: RegExp | undefined
  try {
    compiled = new RegExp(source, 'gu')
  } catch (error: unknown) {
    log(`transcript-secrets: skipping invalid extraPattern: ${String(error)}`)
    compiled = undefined
  }
  extraCache.set(source, compiled)
  return compiled ?? undefined
}

/**
 * One-way redaction of built-in credential patterns, env-name-matched values,
 * and caller-supplied extra patterns.
 * @param text - the transcript text to scrub.
 * @param opts - extra regex sources and an optional log sink.
 * @returns the redacted text, match count, and matched env-var names.
 */
export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  const log = opts.log ?? (() => {})
  let out = text
  let matches = 0
  const envNames: string[] = []
  for (const { source } of BUILT_IN_PATTERNS) {
    const regex = new RegExp(source, 'gu')
    out = out.replace(regex, () => {
      matches += 1
      return REDACTED
    })
  }
  for (const source of opts.extraPatterns ?? []) {
    const regex = compileExtra(source, log)
    if (regex === undefined) continue
    regex.lastIndex = 0
    out = out.replace(regex, () => {
      matches += 1
      return REDACTED
    })
  }
  for (const [name, value] of getEnvSnapshot()) {
    if (!out.includes(value)) continue
    out = out.split(value).join(REDACTED)
    matches += 1
    envNames.push(name)
  }
  return { text: out, matches, envNames }
}

/** The `cc-secrets` settings shape. */
export interface SecretsSettings {
  /** Extra regex sources compiled on first use. */
  readonly extraPatterns: readonly string[]
  /** Whether the crusher store write applies redaction. */
  readonly redactCrusherStore: boolean
}

/** Schema for the `cc-secrets` settings namespace. */
export const SecretsSettingsSchema = z.object({
  extraPatterns: z.array(z.string()).default([]),
  redactCrusherStore: z.boolean().default(true),
})

const SETTINGS_NAMESPACE = 'cc-secrets' as SettingsNamespace

/**
 * Register the `cc-secrets` namespace (idempotent) and return a live per-use
 * reader — settings hot reload applies without re-boot. Graceful without a
 * settings provider: returns the schema defaults.
 * @param ctx - the plug context.
 * @returns a reader resolving the live secrets settings.
 */
export function readSecretsSettings(ctx: Context): () => SecretsSettings {
  const read = registerNamespaceSafe<SecretsSettings>(
    ctx,
    SETTINGS_NAMESPACE,
    // The schema's structural type uses mutable arrays; the public surface is
    // the readonly SecretsSettings view. Cast through unknown once here.
    SecretsSettingsSchema as unknown as z<SecretsSettings>,
  )
  return () => {
    const value = read()
    return value ?? { extraPatterns: [], redactCrusherStore: true }
  }
}
