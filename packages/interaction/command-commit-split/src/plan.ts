/**
 * Pure plan logic for `/commit-split`: validation of the model's STRICT JSON
 * plan, dependency-cycle detection (topological, in the command — never in
 * the model), source > test > docs ranking, lockfile exclusion into a
 * trailing `chore(deps)` group, and deterministic rendering.
 * @module @dsh-cc/command-commit-split/plan
 */

/** Exact schema-error string pinned by the design (plan C5). */
export const SCHEMA_ERROR = 'error: model output did not match the plan schema'
/** Exact cycle-error prefix pinned by the design (plan C5). */
export const CYCLE_ERROR_PREFIX = 'error: dependency cycle among groups: '

/** One proposed atomic commit. */
export interface PlanGroup {
  /** One-line commit message (≤ 72 chars, pinned by the prompt). */
  readonly message: string
  /** Unified staged+unstaged file paths belonging to this commit. */
  readonly files: readonly string[]
  /** `A → B` pairs between group messages: A depends on B (B first). */
  readonly dependencyEdges: readonly string[]
}

/** Files that never join a model group; they become the trailing deps group. */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'])

/** The trailing lockfile-only group message, pinned by the design. */
export const DEPS_GROUP_MESSAGE = 'chore(deps)'

const EDGE_SEPARATOR = ' → '

/**
 * File classification for the ranking rule (source > test > docs).
 * @param path - repo-relative file path.
 */
export function rankOf(path: string): 0 | 1 | 2 {
  if (/(^|\/)(tests?|__tests__)\//u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)) return 1
  if (/\.md$/iu.test(path) || /(^|\/)docs\//u.test(path)) return 2
  return 0
}

/** Extract the JSON array from the model text, tolerating a markdown fence. */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  const raw = fenced === null ? trimmed : fenced[1] ?? ''
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Structural guard for one edge: exactly one `A → B` separator, non-empty ends. */
function isEdge(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(EDGE_SEPARATOR)
  return parts.length === 2
    && parts[0] !== undefined && parts[0].trim() !== ''
    && parts[1] !== undefined && parts[1].trim() !== ''
}

/**
 * Validate the model output against the pinned STRICT schema: an array of
 * `{ message, files, dependencyEdges }` where every file is a changed path
 * and every edge endpoint is a group message. Anything else → schema error.
 * @param text - raw model output.
 * @param changedPaths - the unified changed-file list collected from git.
 * @returns the validated groups, or `undefined` on schema mismatch.
 */
export function parsePlan(text: string, changedPaths: readonly string[]): PlanGroup[] | undefined {
  const parsed: unknown = extractJson(text)
  if (!Array.isArray(parsed)) return undefined
  const known = new Set(changedPaths)
  const groups: PlanGroup[] = []
  const messages = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { message, files, dependencyEdges } = entry as Record<string, unknown>
    if (typeof message !== 'string' || message.trim() === '' || message.includes('\n')) return undefined
    if (!Array.isArray(files) || files.some(f => typeof f !== 'string')) return undefined
    if (!Array.isArray(dependencyEdges) || !dependencyEdges.every(isEdge)) return undefined
    if (!files.every(f => known.has(f))) return undefined
    if (messages.has(message)) return undefined
    messages.add(message)
    groups.push({ message, files, dependencyEdges })
  }
  for (const group of groups) {
    for (const edge of group.dependencyEdges) {
      const [from, to] = edge.split(EDGE_SEPARATOR)
      if (!messages.has(from ?? '') || !messages.has(to ?? '')) return undefined
    }
  }
  return groups
}

/** Drop lockfiles from a group's file list; returns `undefined` when it empties. */
function stripLockfiles(group: PlanGroup): PlanGroup | undefined {
  const files = group.files.filter(f => !LOCKFILES.has(f))
  return files.length === 0 ? undefined : { ...group, files }
}

/**
 * Detect a dependency cycle over the returned edges and, when one exists,
 * render the pinned error naming the cycle path via group messages.
 * @param groups - validated plan groups.
 * @returns the cycle error string, or `undefined` when acyclic.
 */
export function findCycle(groups: readonly PlanGroup[]): string | undefined {
  const byMessage = new Map(groups.map(g => [g.message, g]))
  const adjacency = new Map<string, string[]>()
  for (const group of groups) {
    adjacency.set(group.message, group.dependencyEdges
      .map(edge => edge.split(EDGE_SEPARATOR)[1] ?? '')
      .filter(to => byMessage.has(to)))
  }
  // Iterative DFS coloring: 1 = in-stack, 2 = settled.
  const color = new Map<string, 1 | 2>()
  const path: string[] = []
  const visit = (node: string): string | undefined => {
    const state = color.get(node)
    if (state === 1) {
      const start = path.indexOf(node)
      return [...path.slice(start), node].join(EDGE_SEPARATOR)
    }
    if (state === 2) return undefined
    color.set(node, 1)
    path.push(node)
    for (const next of adjacency.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    color.set(node, 2)
    return undefined
  }
  for (const group of groups) {
    const cycle = visit(group.message)
    if (cycle !== undefined) return CYCLE_ERROR_PREFIX + cycle
  }
  return undefined
}

/**
 * Order the plan: dependency-first (Kahn's algorithm over `A → B` edges,
 * B committed before A) with source > test > docs as the deterministic
 * tie-break (a group ranks by its highest-ranked file).
 * @param groups - validated, acyclic plan groups.
 * @returns the ordered plan.
 */
export function orderPlan(groups: readonly PlanGroup[]): PlanGroup[] {
  const remaining = [...groups]
  const committed = new Set<string>()
  const ordered: PlanGroup[] = []
  const depsOf = (group: PlanGroup): string[] =>
    group.dependencyEdges
      .map(edge => edge.split(EDGE_SEPARATOR)[1] ?? '')
      .filter(to => remaining.some(g => g.message === to))
  while (remaining.length > 0) {
    const ready = remaining.filter(g => depsOf(g).every(dep => committed.has(dep)))
    // Acyclicity is checked before ordering, so `ready` is never empty here.
    const next = ready.reduce((best, g) =>
      Math.min(...g.files.map(rankOf)) < Math.min(...best.files.map(rankOf)) ? g : best)
    ordered.push(next)
    committed.add(next.message)
    remaining.splice(remaining.indexOf(next), 1)
  }
  return ordered
}

/** True when at least one changed path is not a lockfile. */
export function hasNonLockfileChanges(changedPaths: readonly string[]): boolean {
  return changedPaths.some(p => !LOCKFILES.has(p))
}

/**
 * Build the full plan for rendering: strip lockfiles out of the model groups,
 * append the trailing `chore(deps)` group when lockfiles are present, and
 * order dependency-first. Returns an error string for schema or cycle
 * failures — in both cases no plan is emitted.
 * @param modelText - raw model output.
 * @param changedPaths - unified changed-file list from the collector.
 * @returns `{ error }` or `{ plan }`, exactly one of the two.
 */
export function buildPlan(modelText: string, changedPaths: readonly string[]): { error: string } | { plan: readonly PlanGroup[] } {
  const parsed = parsePlan(modelText, changedPaths)
  if (parsed === undefined) return { error: SCHEMA_ERROR }
  const lockfiles = changedPaths.filter(p => LOCKFILES.has(p))
  const kept = parsed
    .map(stripLockfiles)
    .filter((g): g is PlanGroup => g !== undefined)
  if (lockfiles.length > 0) kept.push({ message: DEPS_GROUP_MESSAGE, files: lockfiles, dependencyEdges: [] })
  const cycle = findCycle(kept)
  if (cycle !== undefined) return { error: cycle }
  return { plan: orderPlan(kept) }
}

/** Render one group's block of the plan text. */
function renderGroup(group: PlanGroup, index: number): string {
  const lines = [`${index + 1}. ${group.message}`, ...group.files.map(f => `   - ${f}`)]
  for (const edge of group.dependencyEdges) lines.push(`   ${edge}`)
  return lines.join('\n')
}

/**
 * Render the final advisory text. Dry-run-only: the footer states the
 * declared heuristic and that nothing was committed.
 * @param plan - ordered plan groups.
 * @returns the multi-line advisory output.
 */
export function renderPlan(plan: readonly PlanGroup[]): string {
  const lines = [
    'proposed split plan (dry-run — nothing was committed):',
    '',
    ...plan.map(renderGroup),
    '',
    'dependency heuristic (declared): shared top-level directory plus',
    'import-reference overlap between changed files; ranking source > test > docs;',
    'lockfiles are excluded into the trailing chore(deps) group. Execute the',
    'proposals one by one if you agree with the split.',
  ]
  return lines.join('\n')
}

/** System prompt for the deep-reasoning lane (alias 'blueprint'). */
export const SPLIT_SYSTEM_PROMPT = [
  'You split a mixed working-tree change into ordered atomic commits.',
  'Signals to use: shared top-level directory, and textual import-reference',
  'overlap between changed files (an edge A→B exists iff A imports changed',
  'file B; resolve imports relative-first). Rank source above tests above docs.',
  'Lockfiles must never appear in a group. Reply with STRICT JSON ONLY: an',
  'array of objects { "message", "files", "dependencyEdges" } where message is',
  'a one-line commit message of at most 72 characters, files is a subset of the',
  'listed changed paths, and dependencyEdges lists "A → B" strings between group',
  'messages meaning A depends on B (B must be committed first). No markdown,',
  'no commentary — JSON only.',
].join(' ')
