/**
 * Two-phase application of the cascade's top-level `env` section. Ordinary
 * variables apply in the first stage; environment-altering variables
 * (`LD_PRELOAD`, `PATH`, and similar) defer to `applyTrustedEnv`, run only
 * after the user grants trust for them. Values are coerced to strings.
 * @module @dsh-cc/settings-cascade/env
 */

/** Environment variables that alter process behavior or library loading. */
export const DANGEROUS_ENV_VARS: readonly string[] = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PATH',
  'PYTHONPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'RUBYLIB',
  'PERL5LIB',
] as const

const DANGEROUS = new Set<string>(DANGEROUS_ENV_VARS)

/** One parsed `env` entry: variable name to a value coerced to string on apply. */
export type EnvSettings = Record<string, unknown>

/**
 * Coerce one configured `env` value into the string a process environment
 * carries. Numbers and booleans stringify literally; objects and arrays
 * serialize as JSON; a string passes through unchanged.
 * @param value - the configured raw value.
 * @returns the string form to assign to the environment variable.
 */
export function coerceEnv(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Write a new environment mapping from an env section merged over a base. */
function apply(env: EnvSettings, target: Record<string, string> | undefined, includeDangerous: boolean): Record<string, string> {
  const out: Record<string, string> = { ...target }
  for (const [name, raw] of Object.entries(env)) {
    if (!includeDangerous && DANGEROUS.has(name)) continue
    out[name] = coerceEnv(raw)
  }
  return out
}

/**
 * Apply the first (untrusted) stage of an `env` section: every ordinary
 * variable is assigned, dangerous variables are held back for the trusted
 * stage. The returned mapping is a new object; neither input is mutated.
 * @param env - the parsed `env` section.
 * @param target - optional existing environment mapping to merge over.
 * @returns the next environment mapping without dangerous variables.
 */
export function applyEnv(env: EnvSettings, target?: Record<string, string>): Record<string, string> {
  return apply(env, target, false)
}

/**
 * Apply the trusted stage of an `env` section: dangerous variables are
 * assigned together with ordinary ones. Call only after the user has granted
 * trust for environment-altering variables.
 * @param env - the parsed `env` section.
 * @param target - optional existing environment mapping to merge over.
 * @returns the complete next environment mapping including dangerous variables.
 */
export function applyTrustedEnv(env: EnvSettings, target?: Record<string, string>): Record<string, string> {
  return apply(env, target, true)
}
