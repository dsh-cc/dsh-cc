/**
 * The LOCAL minimal head scrubber (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §4): six ordered steps
 * over the raw bash command before it is stored on a receipt's session event.
 * No dependency on transcript-secrets internals — deliberately self-contained.
 *
 * 1. strip leading KEY=value env assignments;
 * 2. redact non-leading KEY=value assignment values;
 * 3. redact `--token`/`--password`/`--auth` flag values;
 * 4. redact -H/--header values carrying Authorization/Bearer/token material;
 * 5. redact -u/--user values;
 * 6. truncate to 200 bytes, UTF-8-safe.
 *
 * @module @dsh-cc/completion-gate/scrub
 */

/** Max stored head size in UTF-8 bytes (§3.2/§4 step 6). */
export const HEAD_MAX_BYTES = 200

const REDACTED = '<redacted>'

/**
 * UTF-8-safe byte truncation (turn-rules `truncateUtf8` precedent): operates
 * at the byte level, so a split multi-byte sequence degrades to a replacement
 * character instead of corrupting earlier bytes.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

/** A quoted or bare shell word (used for values we may redact). */
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`

/** Leading KEY=value env assignment (step 1: stripped entirely). */
const LEADING_ENV = new RegExp(`^(?:\\s*[A-Za-z_][A-Za-z0-9_]*=${VALUE}\\s+)+`)
/** Non-leading KEY=value assignment (step 2: value redacted, key kept). */
const ENV_ASSIGN = new RegExp(String.raw`(?<![\w-])([A-Za-z_][A-Za-z0-9_]*)=(?!=)${VALUE}`, 'g')
/** Secret-bearing long flags, `--flag value` and `--flag=value` (step 3). */
const SECRET_FLAG_EQ = /(--(?:token|password|auth)[a-z-]*=)(?:"[^"]*"|'[^']*'|\S+)/gi
const SECRET_FLAG_SPACE = /(--(?:token|password|auth)[a-z-]*\s+)(?:"[^"]*"|'[^']*'|\S+)/gi
/** -H/--header values (step 4: redacted only when carrying auth material). */
const HEADER_FLAG = /(-H|--header)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi
/** -u/--user values (step 5). */
const USER_FLAG = /(^|\s)(-u|--user)([ =])(?:"[^"]*"|'[^']*'|\S+)/g

/**
 * Run the six scrub steps (§4). Pure function over the command string.
 */
export function scrubHead(command: string): string {
  let s = command
  // 1. strip leading env assignments (whole tokens).
  s = s.replace(LEADING_ENV, '')
  // 2. redact non-leading assignment values (keep the key).
  s = s.replace(ENV_ASSIGN, `$1=${REDACTED}`)
  // 3. redact secret flag values.
  s = s.replace(SECRET_FLAG_EQ, `$1${REDACTED}`)
  s = s.replace(SECRET_FLAG_SPACE, `$1${REDACTED}`)
  // 4. redact header values that carry auth material.
  s = s.replace(HEADER_FLAG, (match, flag: string, sep: string, value: string) =>
    /authorization|bearer|token/i.test(value) ? `${flag}${sep}${REDACTED}` : match)
  // 5. redact -u/--user values.
  s = s.replace(USER_FLAG, `$1$2$3${REDACTED}`)
  // 6. UTF-8-safe truncation.
  return truncateUtf8(s, HEAD_MAX_BYTES)
}
