/**
 * Pure `/agents` snapshot + rendering: the thin data model shared by the
 * preset command handler and the TUI local-slash surface (plan
 * docs/plans/2026-09-10-continuable-background-ux.md §3.2). All functions are
 * pure over the injected duck-typed services, so they unit-test without
 * cordis. The preset surface renders this model exactly; the TUI may ADD
 * decorations (provider/model, prompt excerpt, last stopReason) from its own
 * event fold — never different ids or ordering.
 * @module @dsh-cc/command-agents/snapshot
 */

/** Per-child residency. Derivation follows the F7 pattern, not a new source. */
export type Residency = 'running' | 'idle' | 'ready'

/** Pin state row: `blocked` carries the stable gate deny code when parseable. */
export interface AgentPinView {
  readonly state: 'pinned' | 'blocked' | 'corrupt'
  readonly denyCode?: string
}

/** One thin snapshot row, shared verbatim by both surfaces. */
export interface AgentRow {
  /** Durable child session id (stable across Activations). */
  readonly id: string
  /** Durable creation label from the child's descriptor, when present. */
  readonly label?: string
  /** Derived residency: Working / Idle / Ready. */
  readonly residency: Residency
  /** Whether the child has durable subagent descendants. */
  readonly hasChildren: boolean
  /** Pin state; `undefined` when the child has no resume pin. */
  readonly pin?: AgentPinView
  /** The parent session id the listing was rooted at. */
  readonly parentId: string
}

/** The duck-typed `listChildren` entry subset this snapshot consumes. */
export interface ChildEntryLike {
  readonly id: string
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
  readonly mode?: string
  readonly label?: string
}

/** The subset of a resume pin the detail renders (schema v1 fields). */
export interface PinLike {
  readonly childId: string
  readonly label?: string
  readonly mode?: string
  readonly definition?: { readonly agentType: string; readonly source?: string }
  readonly modelSelector?: { readonly raw: string; readonly via?: string }
  readonly workspace?: { readonly cwd: string; readonly branch: string }
  readonly resume: { readonly state: 'ok' | 'blocked'; readonly reason?: string }
}

/** Corrupt-pin sentinel mirrored from the PinStore. */
export interface CorruptPinLike {
  readonly kind: 'corrupt'
  readonly reason: string
}

/**
 * The services the snapshot reads. `listChildren` comes from the host-plane
 * `subagents` registry, `getAgent` from the cordis `agents` registry, and the
 * pin seam from the realm-interior `resumePinStore` service. `interrupt`
  * is consumed by the command handler only — never by the read-only snapshot.
 */
export interface SnapshotServices {
  listChildren(parentSessionId: string): Promise<readonly ChildEntryLike[]>
  getAgent(id: string): { status?: string } | undefined
  readPin(childId: string): PinLike | CorruptPinLike | undefined
  pinPath(childId: string): string
}

/**
 * Extract the stable bracketed gate deny code from a persisted deny reason
 * (`[CODE] human reason`), per the gate's own copy convention.
 */
export function denyCodeOf(reason: string): string | undefined {
  const match = /^\[([A-Z][A-Z0-9_]+)\]/.exec(reason)
  return match === null ? undefined : match[1]
}

function pinViewOf(pin: PinLike | CorruptPinLike | undefined): AgentPinView | undefined {
  if (pin === undefined) return undefined
  if ('kind' in pin && (pin as CorruptPinLike).kind === 'corrupt') return { state: 'corrupt' }
  const pinLike = pin as PinLike
  if (pinLike.resume.state === 'blocked') {
    const denyCode = pinLike.resume.reason === undefined ? undefined : denyCodeOf(pinLike.resume.reason)
    if (denyCode === undefined) return { state: 'blocked' }
    return { state: 'blocked', denyCode }
  }
  return { state: 'pinned' }
}

/**
 * Derive one child's residency: a live running activation is `running`; a
 * live but not-running activation is `idle`; no live agent (settled
 * continuable or persistence-only) is `ready` — resumable, per the harness's
 * own ready semantics (F7 derive pattern).
 */
function residencyOf(entry: ChildEntryLike, live: { status?: string } | undefined): Residency {
  if (entry.activity === 'inactive') return 'ready'
  if (live === undefined) return 'ready'
  return live.status === 'running' ? 'running' : 'idle'
}

/**
 * Build the thin snapshot for one parent session's direct children.
 * @param services - the injected read seams.
 * @param parentSessionId - the listing root (the caller's session id).
 */
export async function buildAgentsSnapshot(
  services: SnapshotServices,
  parentSessionId: string,
): Promise<AgentRow[]> {
  const children = await services.listChildren(parentSessionId)
  const list: AgentRow[] = []
  for (const entry of children) {
    if (entry.mode === 'one-shot') continue
    const live = services.getAgent(String(entry.id))
    list.push({
      id: String(entry.id),
      ...(entry.label !== undefined && entry.label.length > 0 ? { label: entry.label } : {}),
      residency: residencyOf(entry, live),
      hasChildren: entry.hasChildren === true,
      ...(() => {
        const pin = pinViewOf(services.readPin(String(entry.id)))
        return pin === undefined ? {} : { pin }
      })(),
      parentId: parentSessionId,
    })
  }
  // Deterministic: group order is applied by the renderer; here sort by
  // label-then-id so both surfaces show identical ordering.
  list.sort((a, b) =>
    (a.label ?? a.id).localeCompare(b.label ?? b.id) || a.id.localeCompare(b.id))
  return list
}

/** Marker per row residency: `●` running, `○` idle, `◇` ready (resumable). */
const MARKERS: Record<Residency, string> = { running: '●', idle: '○', ready: '◇' }

const GROUP_ORDER: readonly Residency[] = ['running', 'idle', 'ready']
const GROUP_TITLES: Record<Residency, string> = {
  running: 'Working',
  idle: 'Idle',
  ready: 'Ready',
}

/** Shorten a child id for row display (first 8 of the tail hex when hyphenated). */
export function shortIdOf(id: string): string {
  const tail = id.includes('-') ? id.split('-').at(-1) ?? id : id
  return tail.length > 8 ? tail.slice(0, 8) : id
}

/**
 * Render the grouped list. Groups follow residency only — Working / Idle /
 * Ready; there is deliberately no Blocked or Done group (§3.2).
 */
export function renderAgentsList(rows: readonly AgentRow[]): string {
  if (rows.length === 0) return 'No background agents.'
  const lines: string[] = ['Background agents:']
  for (const residency of GROUP_ORDER) {
    const group = rows.filter(row => row.residency === residency)
    if (group.length === 0) continue
    lines.push(`${GROUP_TITLES[residency]} (${group.length}):`)
    for (const row of group) {
      const name = row.label ?? shortIdOf(row.id)
      const tag = row.pin === undefined
        ? ''
        : row.pin.state === 'blocked' && row.pin.denyCode !== undefined
          ? ` [gate: ${row.pin.denyCode}]`
          : row.pin.state === 'blocked'
            ? ' [gate denied]'
            : row.pin.state === 'corrupt'
              ? ' [pin unreadable]'
              : ' [pinned]'
      const childrenTag = row.hasChildren ? ' [has children]' : ''
      lines.push(`  ${MARKERS[row.residency]} ${name} · ${shortIdOf(row.id)}${tag}${childrenTag}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render one child's thin detail: ids, residency, children, and pin
 * provenance. The preset surface renders exactly this; the TUI appends its
 * fold-derived decorations additively.
 */
export function renderAgentDetail(
  row: AgentRow,
  pin: PinLike | CorruptPinLike | undefined,
  pinPath: string | undefined,
  parentSessionId: string,
): string {
  const lines: string[] = [`Agent ${row.id}`]
  if (row.label !== undefined) lines.push(`  label: ${row.label}`)
  lines.push(`  residency: ${row.residency}`)
  lines.push(`  children: ${row.hasChildren ? 'present' : 'none'}`)
  lines.push(`  parent session: ${parentSessionId}`)
  if (pin === undefined) {
    lines.push('  pin: none (not pinnable or not background-spawned)')
    return lines.join('\n')
  }
  if ('kind' in pin && pin.kind === 'corrupt') {
    lines.push(`  pin: UNREADABLE at ${pinPath ?? '<unknown>'} (${pin.reason})`)
    return lines.join('\n')
  }
  const resumePin = pin as PinLike
  lines.push(`  pin: ${pinPath ?? '<unknown>'}`)
  if (resumePin.mode !== undefined) lines.push(`  pin mode: ${resumePin.mode}`)
  if (resumePin.definition !== undefined) {
    const source = resumePin.definition.source === undefined ? '' : ` (${resumePin.definition.source})`
    lines.push(`  pin definition: ${resumePin.definition.agentType}${source}`)
  }
  if (resumePin.modelSelector !== undefined) {
    lines.push(`  pin model: ${resumePin.modelSelector.raw}${resumePin.modelSelector.via === undefined ? '' : ` via ${resumePin.modelSelector.via}`}`)
  }
  if (resumePin.workspace !== undefined) {
    lines.push(`  pin workspace: ${resumePin.workspace.branch} @ ${resumePin.workspace.cwd}`)
  }
  if (resumePin.resume.state === 'blocked') {
    lines.push(`  gate: denied ${resumePin.resume.reason ?? ''}`.trimEnd())
  } else {
    lines.push('  gate: ok (last evaluation passed)')
  }
  return lines.join('\n')
}

/**
 * Parsed `/agents` input grammar.
 */
export type ParsedAgentsInput =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly id: string }
  | { readonly kind: 'stop'; readonly id: string }
  | { readonly kind: 'error'; readonly text: string }

/** Copy for a stop request on a running child (both surfaces share it). */
export function stopRunningCopy(id: string): string {
  return `Interrupt requested for agent ${id}; it stays resumable — /agents for status.`
}

/** Copy for a stop request on an idle/ready child (shared no-op explanation). */
export function stopNotRunningCopy(id: string, residency: string): string {
  return `Agent ${id} is not running (residency: ${residency}); nothing to stop — it is resumable.`
}

/** Copy for a stop/detail on an id the snapshot does not know. */
export function unknownAgentCopy(id: string): string {
  return `No agent ${id} among this session's background agents; /agents lists current ids.`
}

/** Copy for the reserved `attach` namespace (P1). */
export function attachReservedCopy(): string {
  return '/agents attach is not implemented yet (namespace reserved).'
}

/**
 * Parse the raw text after `/agents`. Grammar: '' | '<id>' | 'stop <id>'.
 * `attach` is a reserved namespace (P1) — named as not implemented, never
 * silently dropped.
 */
export function parseAgentsInput(raw: string): ParsedAgentsInput {
  const input = raw.trim()
  if (input.length === 0) return { kind: 'list' }
  const parts = input.split(/\s+/)
  if (parts[0] === 'stop') {
    if (parts.length < 2 || parts[1]!.length === 0) {
      return { kind: 'error', text: 'Usage: /agents stop <id>' }
    }
    return { kind: 'stop', id: parts[1]! }
  }
  if (parts[0] === 'attach') {
    return { kind: 'error', text: attachReservedCopy() }
  }
  return { kind: 'detail', id: parts[0]! }
}
