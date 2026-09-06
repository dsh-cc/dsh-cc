/**
 * Approval and question overlay containers. Rendered inline (not as pi-tui
 * overlays) so they participate in the main-screen scrollback flow, matching
 * the previous Ink layout.
 * @module @dsh-cc/tui/components/overlays
 */

import { Container, Markdown, Text } from '@dsh-cc/pi-tui'
import { BYPASS_CONFIRMATION } from '@dsh-cc/command-permissions'
import type {
  ApprovalView,
  EffortPickerView,
  ModelPickerView,
  PermissionPickerView,
  QuestionView,
  SessionSwitcherView,
  TodoItemView,
  UsageTotalsView,
  UsageView,
  WorktreeExitView,
} from '../store.ts'
import { renderDiffLines } from './diff-card.ts'
import { createMarkdownTheme } from './markdown-theme.ts'
import { defaultTheme, type Theme } from './theme.ts'
import { formatSessionRow } from '../harness/session-list.ts'

/**
 * Cap on command/JSON preview lines in an approval box so a long payload
 * cannot push the composer off-screen; a trailing `…` marks the cut.
 */
const APPROVAL_PREVIEW_MAX_LINES = 8

/**
 * Cap on diff lines in an approval box, passed to the transcript's diff
 * renderer (which cuts on a hunk boundary and appends its own dim trailer).
 */
const APPROVAL_DIFF_MAX_LINES = 16

/**
 * Approval box: the title ("Approve <tool>?", or "Approval (1 of N)" when
 * other modals wait behind this one) + optional reason + the structured
 * payload preview (command block, diff card, or raw-arguments JSON block) +
 * an explicit key→outcome hint including the always-allow option.
 */
export function createApprovalBox(approval: ApprovalView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  const title = approval.pendingCount === undefined
    ? `Approve ${approval.toolName}?`
    : `Approval (1 of ${approval.pendingCount + 1})`
  box.addChild(new Text(theme.warning(title), 0, 0))
  if (approval.reason !== undefined) {
    box.addChild(new Text(theme.muted(approval.reason), 0, 0))
  }
  const preview = approval.preview
  if (preview?.kind === 'command') {
    for (const line of previewLines(preview.command, APPROVAL_PREVIEW_MAX_LINES)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  } else if (preview?.kind === 'diff') {
    for (const line of renderDiffLines(preview.diffs, APPROVAL_DIFF_MAX_LINES, theme)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  } else if (preview?.kind === 'args') {
    for (const line of previewLines(preview.json, APPROVAL_PREVIEW_MAX_LINES)) {
      box.addChild(new Text(theme.muted(line), 0, 0))
    }
  }
  box.addChild(new Text(theme.muted('1 once · 2 no · 3 always · s session'), 0, 0))
  return box
}

/**
 * Cap a multi-line preview at `maxLines`; a trailing `…` marks the cut so a
 * long payload cannot push the composer off-screen.
 */
function previewLines(text: string, maxLines: number): string[] {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!} …`]
}

/**
 * Question box v2: title + question text, the plan markdown for plan-review
 * intents, focusable option rows (multi-select checkboxes), the trailing
 * free-text "Other" row, and a key hint footer.
 */
export function createQuestionBox(question: QuestionView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  const planReview = question.intent?.kind === 'plan-review' && question.detail !== undefined
  box.addChild(new Text(theme.bold(planReview ? 'Plan review' : question.header), 0, 0))
  box.addChild(new Text(question.question, 0, 0))
  if (planReview) {
    box.addChild(new Markdown(question.detail!, 0, 0, createMarkdownTheme(theme)))
  }

  const lastRow = question.options.length // trailing "Other" row index
  for (let index = 0; index <= lastRow; index += 1) {
    const focused = question.focused === index
    const marker = focused ? '❯ ' : '  '
    if (index < question.options.length) {
      const option = question.options[index]!
      const check = question.multiSelect
        ? question.selected.includes(option.label) ? '[x] ' : '[ ] '
        : ''
      const description = option.description === undefined
        ? ''
        : theme.muted(` — ${option.description}`)
      box.addChild(new Text(`${marker}${index + 1}. ${check}${option.label}${description}`, 0, 0))
    } else {
      box.addChild(new Text(`${marker}Other: ${question.custom}`, 0, 0))
    }
  }

  const hint = question.multiSelect
    ? '↑↓ move · space toggle · enter confirm · esc cancel'
    : '↑↓ move · enter select · type to answer freely · esc cancel'
  box.addChild(new Text(theme.muted(hint), 0, 0))
  return box
}

/**
 * Maximum model-picker rows rendered at once. A longer catalog is windowed
 * around the focus so the box can never overflow the frame (the 16-line
 * catalog-dump regression class).
 */
const MODEL_PICKER_VISIBLE_ROWS = 10

/**
 * Model picker box: a modal list of `provider/id — name` rows with a `❯`
 * focus marker and a `*` on the active route, windowed to
 * {@link MODEL_PICKER_VISIBLE_ROWS} rows around the focus.
 *
 * Hand-rolled (not the vendored `SelectList`) because SelectList owns its own
 * `selectedIndex` and routes input through its own `handleInput`, which would
 * fight the driver-owned `modelPicker` state and the emit/setter flow the rest
 * of the overlays use. SelectList also renders a `→` prefix and a two-column
 * layout that clash with the `❯` + Text-row convention shared by the approval
 * and question boxes. A focused-list mirroring the question overlay keeps one
 * state owner and one styling language.
 */
export function createModelPickerBox(picker: ModelPickerView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Select model'), 0, 0))

  const total = picker.entries.length
  const cap = MODEL_PICKER_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(picker.focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const entry = picker.entries[index]!
    const focused = picker.focused === index
    const isCurrent = picker.current !== undefined
      && picker.current.provider === entry.provider
      && picker.current.model === entry.id
    const marker = focused ? '❯ ' : '  '
    const currentMark = isCurrent ? ' *' : ''
    box.addChild(new Text(`${marker}${entry.provider}/${entry.id} — ${entry.name}${currentMark}`, 0, 0))
  }

  box.addChild(new Text(theme.muted('↑↓ move · enter select · esc cancel'), 0, 0))
  return box
}

/**
 * Maximum effort-picker rows rendered at once. Mirrors the model picker cap so
 * an unexpectedly long effort list can never overflow the frame.
 */
const EFFORT_PICKER_VISIBLE_ROWS = 10

/**
 * Effort picker box: a modal list of the active model's reasoning-effort
 * levels with a `❯` focus marker and a `*` on the live effort, windowed to
 * {@link EFFORT_PICKER_VISIBLE_ROWS} rows around the focus. The trailing
 * reserved `'default'` entry renders as `default (provider)` to make clear it
 * restores the provider default rather than selecting a level named default.
 */
export function createEffortPickerBox(picker: EffortPickerView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Select effort'), 0, 0))

  const total = picker.entries.length
  const cap = EFFORT_PICKER_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(picker.focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const entry = picker.entries[index]!
    const focused = picker.focused === index
    const isCurrent = picker.current === entry
    const marker = focused ? '❯ ' : '  '
    const label = entry === 'default' ? 'default (provider)' : entry
    const currentMark = isCurrent ? ' *' : ''
    box.addChild(new Text(`${marker}${label}${currentMark}`, 0, 0))
  }

  box.addChild(new Text(theme.muted('↑↓ move · enter select · esc cancel'), 0, 0))
  return box
}

/**
 * Permission picker box: a modal list of the five CC rule-engine modes with
 * a `❯` focus marker and a `*` on the live mode. While `confirmingBypass`
 * is set the list is replaced by the shared bypass risk-gate copy.
 */
export function createPermissionPickerBox(picker: PermissionPickerView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  if (picker.confirmingBypass === true) {
    box.addChild(new Text(theme.bold(BYPASS_CONFIRMATION.title), 0, 0))
    box.addChild(new Text(BYPASS_CONFIRMATION.description, 0, 0))
    box.addChild(new Text(theme.muted('enter confirm · esc back'), 0, 0))
    return box
  }

  box.addChild(new Text(theme.bold('Select permission mode'), 0, 0))
  for (let index = 0; index < picker.entries.length; index += 1) {
    const entry = picker.entries[index]!
    const focused = picker.focused === index
    const marker = focused ? '❯ ' : '  '
    const currentMark = picker.current === entry.id ? ' *' : ''
    box.addChild(new Text(`${marker}${entry.label}${currentMark}`, 0, 0))
  }
  box.addChild(new Text(theme.muted('↑↓ move · enter select · esc cancel'), 0, 0))
  return box
}

/**
 * Maximum session-switcher rows rendered at once. Mirrors the model picker
 * cap so a long session list can never overflow the frame.
 */
const SESSION_SWITCHER_VISIBLE_ROWS = 10

/**
 * Session switcher box: title `Resume session` (plus the live query while a
 * filter is typed), rows of relative last-activity time + title (or short
 * id) + short id via {@link formatSessionRow}, with the cwd basename added
 * in all-projects scope, a `❯` focus marker, and a `●` on the current
 * session, windowed to {@link SESSION_SWITCHER_VISIBLE_ROWS} rows. An empty
 * visible list explains itself (cwd scope hints at Tab → all projects). A
 * dim `Switching…` footer replaces the key hint while a switch is in flight
 * (input blocked).
 */
export function createSessionSwitcherBox(sw: SessionSwitcherView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  const querySuffix = sw.query.length > 0 ? theme.muted(`  /${sw.query}`) : ''
  box.addChild(new Text(theme.bold('Resume session') + querySuffix, 0, 0))

  const total = sw.sessions.length
  if (total === 0) {
    const empty = sw.scope === 'all'
      ? 'No matching sessions'
      : sw.totalCount === undefined
      ? 'No sessions in this project — Tab to view all'
      : `No sessions in this project — Tab to view all (${sw.totalCount})`
    box.addChild(new Text(theme.muted(empty), 0, 0))
  } else {
    const cap = SESSION_SWITCHER_VISIBLE_ROWS
    let start = 0
    if (total > cap) {
      start = Math.max(0, Math.min(sw.focused - Math.floor(cap / 2), total - cap))
    }
    const end = Math.min(start + cap, total)

    for (let index = start; index < end; index += 1) {
      const session = sw.sessions[index]!
      const row = formatSessionRow(session, {
        now: Date.now(),
        currentId: sw.currentId,
        // All scope labels every row; cwd (project) scope labels only rows
        // recorded elsewhere — worktree / subdirectory sessions of the same
        // project — so they stay distinguishable from same-cwd ones.
        showCwd: sw.scope === 'all'
          || (session.cwd !== undefined && sw.cwd !== undefined && session.cwd !== sw.cwd),
      })
      const marker = sw.focused === index ? '❯ ' : '  '
      const currentMark = row.current ? ' ●' : ''
      const cwdPart = row.cwdPart === undefined ? '' : theme.muted(` — ${row.cwdPart}`)
      box.addChild(new Text(
        `${marker}${row.time} ${row.label} ${row.shortId}${cwdPart}${currentMark}`,
        0, 0,
      ))
    }
  }

  box.addChild(new Text(
    sw.switching
      ? theme.muted('Switching…')
      : theme.muted('↑↓ move · enter resume · tab all projects · type to filter · esc close'),
    0, 0,
  ))
  return box
}

/**
 * Maximum todo-panel rows rendered at once. A longer list is windowed around
 * the focus (mirroring the model picker cap) so the box can never overflow
 * the frame.
 */
const TODO_PANEL_VISIBLE_ROWS = 12

/**
 * Status icon for one todo row: checked for completed, half-full for the
 * in-progress item, empty for pending.
 */
function todoIcon(status: TodoItemView['status']): string {
  if (status === 'completed') return '☑'
  if (status === 'in_progress') return '◐'
  return '☐'
}

/**
 * Todo panel box: the session todo list with status icons, a `❯` focus
 * marker, and a key hint footer, windowed to {@link TODO_PANEL_VISIBLE_ROWS}
 * rows around the focus. An empty (or absent) todo list renders a dim
 * placeholder instead of rows; the panel still opens so Ctrl+T is a stable
 * toggle either way.
 */
export function createTodoPanelBox(todos: readonly TodoItemView[], focused: number, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Todos'), 0, 0))

  const total = todos.length
  if (total === 0) {
    box.addChild(new Text(theme.muted('No todos'), 0, 0))
    box.addChild(new Text(theme.muted('↑↓ navigate · Esc close'), 0, 0))
    return box
  }

  const cap = TODO_PANEL_VISIBLE_ROWS
  let start = 0
  if (total > cap) {
    start = Math.max(0, Math.min(focused - Math.floor(cap / 2), total - cap))
  }
  const end = Math.min(start + cap, total)

  for (let index = start; index < end; index += 1) {
    const todo = todos[index]!
    const marker = focused === index ? '❯ ' : '  '
    box.addChild(new Text(`${marker}${todoIcon(todo.status)} ${todo.content}`, 0, 0))
  }

  box.addChild(new Text(theme.muted('↑↓ navigate · Esc close'), 0, 0))
  return box
}

/** Width (in cells) of the context-occupancy bar in the usage panel. */
const USAGE_BAR_WIDTH = 10

/**
 * Compact token count for the context line: digits below a thousand, then
 * `86k` / `1.2k`-style thousands (single decimal, dropped when it rounds to
 * `.0`; none past three digits).
 */
function compactTokens(count: number): string {
  if (count < 1000) return String(count)
  const k = count / 1000
  const text = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')
  return `${text}k`
}

/**
 * Context-occupancy line: a bar, the percent, and both raw counts —
 * `████░░░░░░ 43% (86k/200k)`. The bar fills by the rounded occupancy ratio
 * with the percent clamped to [0, 100]. Each unknown degrades to a dim
 * fallback: no used count at all renders `n/a`; a used count without a known
 * window renders the count plus a dim `window n/a` (no percent is claimed).
 */
function contextLine(view: UsageView | undefined, theme: Theme): string {
  const { contextUsed, contextWindow } = view ?? {}
  if (contextUsed === undefined) return theme.muted('n/a')
  if (contextWindow === undefined) {
    return theme.muted(`${compactTokens(contextUsed)} tok · window n/a`)
  }
  const ratio = contextUsed / contextWindow
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)))
  const filled = Math.max(0, Math.min(USAGE_BAR_WIDTH, Math.round(ratio * USAGE_BAR_WIDTH)))
  const bar = '█'.repeat(filled) + '░'.repeat(USAGE_BAR_WIDTH - filled)
  return `${bar} ${percent}% (${compactTokens(contextUsed)}/${compactTokens(contextWindow)})`
}

/**
 * Cache-hit rate as a rounded percent, `cacheRead / (input + cacheRead)` —
 * `input` is the uncached bucket, so the denominator is all prompt input.
 * Undefined when there is nothing to show: no `cacheRead` total at all, or a
 * zero denominator (no input and no cache read). Ratios above 1 clamp at 100.
 */
export function cacheHitPercent(totals: UsageTotalsView): number | undefined {
  if (totals.cacheRead === undefined) return undefined
  const denominator = totals.input + totals.cacheRead
  if (denominator === 0) return undefined
  return Math.max(0, Math.min(100, Math.round((totals.cacheRead / denominator) * 100)))
}

/**
 * Aligned `  label  value` rows (thousands separators, shared column widths)
 * for one usage-panel section.
 */
function alignedRows(entries: readonly (readonly [string, number])[]): string[] {
  const labelWidth = Math.max(...entries.map(([label]) => label.length))
  const valueWidth = Math.max(...entries.map(([, value]) => value.toLocaleString('en-US').length))
  return entries.map(([label, value]) =>
    `  ${label.padEnd(labelWidth)}  ${value.toLocaleString('en-US').padStart(valueWidth)}`,
  )
}

/**
 * Usage panel box (`/usage`): the live context-occupancy bar, the cumulative
 * token totals (cache rows only when non-zero, mirroring /cost), and the
 * context breakdown by role. Pure display — no focus or navigation — and
 * each section degrades independently to a dim `n/a` when its projection has
 * no data. Quota and rate-limit figures have no projection at all, so the
 * footer says so explicitly instead of implying the panel is exhaustive.
 */
export function createUsagePanelBox(view: UsageView | undefined, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Usage'), 0, 0))
  box.addChild(new Text(contextLine(view, theme), 0, 0))

  box.addChild(new Text('Tokens', 0, 0))
  const totals = view?.totals
  if (totals === undefined) {
    box.addChild(new Text(theme.muted('n/a'), 0, 0))
  } else {
    const entries: [string, number][] = [['input', totals.input], ['output', totals.output]]
    const { cacheRead, cacheWrite } = totals
    if (cacheRead !== undefined && cacheRead > 0) entries.push(['cache r', cacheRead])
    if (cacheWrite !== undefined && cacheWrite > 0) entries.push(['cache w', cacheWrite])
    for (const line of alignedRows(entries)) {
      box.addChild(new Text(line, 0, 0))
    }
    const hit = cacheHitPercent(totals)
    if (hit !== undefined) box.addChild(new Text(`  hit  ${hit}%`, 0, 0))
  }

  box.addChild(new Text('Breakdown', 0, 0))
  const breakdown = view?.breakdown
  if (breakdown === undefined) {
    box.addChild(new Text(theme.muted('n/a'), 0, 0))
  } else {
    for (const line of alignedRows([
      ['system', breakdown.system],
      ['tools', breakdown.tools],
      ['messages', breakdown.messages],
    ])) {
      box.addChild(new Text(line, 0, 0))
    }
  }

  box.addChild(new Text(theme.muted('quota data unavailable · Esc close'), 0, 0))
  return box
}

/**
 * `/quit` worktree-exit confirmation box: the session descriptor, the
 * removal evidence next to the destructive option, and the three choices
 * (keep / remove / cancel). Focused row carries a `❯` prefix. While a
 * removal is in flight (`busy`) the footer reports progress and keys are
 * swallowed upstream.
 */
export function createWorktreeExitBox(view: WorktreeExitView, theme: Theme = defaultTheme): Container {
  const box = new Container()
  box.addChild(new Text(theme.bold('Exit worktree session?'), 0, 0))
  box.addChild(new Text(`Worktree: ${view.worktreePath}`, 0, 0))
  box.addChild(new Text(`Branch: ${view.branch}`, 0, 0))

  if (view.dirtyFiles !== undefined) {
    box.addChild(new Text(`Uncommitted changes: ${view.dirtyFiles}`, 0, 0))
  }
  // Commits-ahead is only ever known for launcher-managed sessions (it needs
  // the base commit); detected sessions show dirtiness alone.
  if (view.commitsAhead !== undefined) {
    box.addChild(new Text(`Commits ahead of base: ${view.commitsAhead}`, 0, 0))
  }

  const options = [
    'Keep worktree and exit',
    view.ownsBranch ? `Remove worktree and exit (and delete branch ${view.branch})` : 'Remove worktree and exit',
    'Cancel',
  ]
  for (let index = 0; index < options.length; index += 1) {
    const marker = view.focused === index ? '❯ ' : '  '
    box.addChild(new Text(`${marker}${options[index]}`, 0, 0))
  }

  if (view.busy) {
    box.addChild(new Text(theme.muted('Removing worktree…'), 0, 0))
  } else {
    box.addChild(new Text(theme.muted('↑↓ move · enter confirm · esc cancel'), 0, 0))
  }
  return box
}
