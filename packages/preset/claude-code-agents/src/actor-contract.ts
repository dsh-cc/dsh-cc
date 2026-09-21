/**
 * Actor-contract marker helpers: the `<!-- actor-contract:start -->` /
 * `<!-- actor-contract:end -->` pair that wraps a model-gated contract block
 * in an agent definition's persona, plus the model-pattern matcher that
 * decides whether the block stays in the final prompt.
 *
 * The helpers are pure string code — no dependencies — and never mutate a
 * persona that carries no markers. Stripping happens at the spawn seams (the
 * seams own the gate configuration); parse.ts only validates pairing.
 *
 * @module @dsh-cc/claude-code-agents/actor-contract
 */

const START = '<!-- actor-contract:start -->'
const END = '<!-- actor-contract:end -->'

/**
 * DISPATCH-TIME default: the gate ships on for the GLM family (the evidence
 * base). An explicit user `[]` means off everywhere; `['*']` restores the
 * uniform-contract behavior. Kept here (not in a cordis-facing package) so
 * every seam consumer — Task, resume-pins re-fingerprinting, plugin loader —
 * shares one source of truth for the candidates rule.
 */
export const DEFAULT_ACTOR_CONTRACT_MODELS: readonly string[] = ['glm-*']

/**
 * The spawn-time candidate model ids for the gate: the resolved route model id
 * leads, the raw frontmatter token joins when it differs, and an inherit
 * (undefined) model yields NO candidates — the gate is fail-closed on inherit
 * (§3.1's documented off path), even if a route resolves for `undefined`.
 * @param model - the definition's raw frontmatter `model:` token.
 * @param resolved - the route's resolved concrete model, when available.
 * @returns the candidate list to hand to {@link applyActorContract}.
 */
export function gateCandidates(
  model: string | undefined,
  resolved: { readonly model?: string | undefined } | undefined,
): string[] {
  if (model === undefined || model.trim().length === 0) return []
  if (resolved?.model === undefined || resolved.model === model) return [model]
  return [resolved.model, model]
}

/**
 * Match one value against one model pattern: case-insensitive whole-string
 * match where `*` is the only wildcard (zero or more of any character) and
 * every other regex metachar in the pattern is literal.
 * @param value - the concrete model id (or raw token) being tested.
 * @param pattern - the gate pattern, e.g. `glm-*`.
 * @returns whether the whole value matches the whole pattern.
 */
export function matchesModelPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '[\\s\\S]*' : `\\${ch}`))
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

/**
 * Whether any value matches any pattern. The gate opens iff this is true.
 * @param values - the candidate model ids (resolved id plus raw token).
 * @param patterns - the configured gate patterns.
 * @returns whether any candidate matches any pattern.
 */
export function matchesAnyModelPattern(values: readonly string[], patterns: readonly string[]): boolean {
  return values.some((value) => patterns.some((pattern) => matchesModelPattern(value, pattern)))
}

/**
 * Apply the actor-contract gate to a persona: every complete marker pair has
 * its marker lines removed (they are an authoring convention, never prompt
 * content), and the block between them is kept iff some candidate matches
 * some pattern — otherwise the content is excised too, collapsing cleanly so
 * no run of 3+ newlines is left behind. Input with no markers is returned
 * byte-identical, so ungated personas are untouched.
 *
 * Markers are recognized only as whole lines (leading/trailing whitespace on
 * the line is allowed); an inline occurrence inside other text is literal
 * text. An `end` without a prior `start` is likewise literal text — pairing
 * is validated loudly at parse time, so this function only sees well-formed
 * input in practice. For robustness a dangling `start` treats its content as
 * running to end-of-string and is stripped by the same keep/remove rule.
 * @param persona - the agent definition's system prompt.
 * @param candidates - the model ids to test (resolved route id plus raw token).
 * @param patterns - the configured gate patterns; empty means always strip.
 * @returns the persona with markers removed and gated blocks kept or excised.
 */
export function applyActorContract(persona: string, candidates: readonly string[], patterns: readonly string[]): string {
  if (!persona.includes(START) && !persona.includes(END)) return persona
  const keep = matchesAnyModelPattern(candidates, patterns)
  const { text, removed } = extract(persona, keep)
  if (!removed) return persona
  return tidy(text, keep)
}

/**
 * Remove whole-line markers (and gated content when `keep` is false). A
 * removed line takes its trailing newline with it, so the surrounding text
 * keeps the separation the markers stood in; a dangling `start` strips its
 * content to end-of-string by the same rule.
 */
/**
 * Remove whole-line markers (and gated content when `keep` is false). A
 * removed line takes its trailing newline with it, so the surrounding text
 * keeps the separation the markers stood in; a marker on the final line (no
 * trailing newline) takes the preceding newline instead, so removal never
 * grows a dangling one. A dangling `start` strips its content to
 * end-of-string by the same rule.
 */
function extract(persona: string, keep: boolean): { text: string; removed: boolean } {
  const lines = persona.split('\n')
  const cuts: Array<[number, number]> = []
  let open = false
  let removed = false
  let pos = 0
  lines.forEach((line, i) => {
    const start = pos
    const end = start + line.length
    pos = end + 1
    const trimmed = line.trim()
    const isStart = trimmed === START
    const isEnd = open && trimmed === END
    if (isStart) open = true
    else if (isEnd) open = false
    else if (!(open && !keep)) return
    removed = true
    if (i < lines.length - 1) cuts.push([start, end + 1])
    else if (isStart || isEnd) cuts.push([start > 0 ? start - 1 : start, end])
    else cuts.push([start, end])
  })
  if (!removed) return { text: persona, removed: false }
  let text = ''
  let cursor = 0
  for (const [from, to] of cuts) {
    text += persona.slice(cursor, from)
    cursor = to
  }
  return { text: text + persona.slice(cursor), removed: true }
}

/** Collapse blank-line runs, and clean the edges an excision leaves behind. */
function tidy(text: string, keep: boolean): string {
  const collapsed = text.replace(/\n{3,}/g, '\n\n')
  if (keep) return collapsed
  const trimmed = collapsed.replace(/^([ \t]*\n)+/, '')
  return trimmed.replace(/\n[ \t\n]*$/, (tail) => (tail.includes('\n') ? '\n' : tail))
}

/**
 * Parse-time pairing validation for the actor-contract markers on a persona.
 * Only whole-line markers count, exactly as {@link applyActorContract}
 * recognizes them: a `start` with no later `end`, an `end` with no prior
 * `start`, or a second `start` while one is pending throws a descriptive
 * error naming the file and the marker kind — silent prompt corruption is
 * worse than a loud load failure. Nothing is stripped here; that is the
 * spawn seams' job.
 * @param filePath - origin path for the error message.
 * @param persona - the final persona string the agent will carry.
 * @throws when the marker pairing is malformed.
 */
export function validateMarkerPairing(filePath: string, persona: string): void {
  let open = false
  for (const line of persona.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === START) {
      if (open) {
        throw new Error(`${filePath}: nested "${START}" — the previous actor-contract block was never closed with an end marker`)
      }
      open = true
    } else if (open && trimmed === END) {
      open = false
    } else if (!open && trimmed === END) {
      throw new Error(`${filePath}: orphan "${END}" with no earlier start marker`)
    }
  }
  if (open) {
    throw new Error(`${filePath}: unterminated "${START}" — no later end marker`)
  }
}
