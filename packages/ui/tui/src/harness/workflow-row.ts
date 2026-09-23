/**
 * Passive workflow progress row (design slice D2): a second `WorkingLine`
 * instance driven by the engine's `workflow/*` cordis events. Attribution is
 * process-scoped — payloads carry no session identity and cordis emit is
 * unfiltered process-wide — so runs are tracked by id and the row renders the
 * most recently started still-active run (`+N more` when several are active).
 * The row echoes phase titles and counts agents; it never validates against
 * `meta.phases`. `workflow/log` is deliberately not subscribed (high-volume;
 * the consolidated result arrives via the core slice's wake).
 * @module @dsh-cc/tui/harness/workflow-row
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
	WorkflowAgentEndInfo,
	WorkflowAgentInfo,
	WorkflowEventName,
	WorkflowResultInfo,
	WorkflowRunInfo,
} from '@deepseek-ai/dsh-workflow'
import { WorkingLine } from '../components/working-line.ts'
import { formatElapsed } from '../working-line.ts'

/** The five subscribed events — `workflow/log` is intentionally excluded. */
const SUBSCRIBED: readonly WorkflowEventName[] = [
	'workflow/start',
	'workflow/phase',
	'workflow/agent-start',
	'workflow/agent-end',
	'workflow/end',
]

/** Phase title or agent/result detail, per the engine's per-event signatures. */
export type WorkflowEventDetail = string | WorkflowAgentInfo | WorkflowAgentEndInfo | WorkflowResultInfo

export type WorkflowTapListener = (name: WorkflowEventName, info: WorkflowRunInfo, detail: WorkflowEventDetail | undefined) => void

export interface WorkflowEventTap {
	on(listener: WorkflowTapListener): () => void
}

/** A function that wraps text in an SGR style (same shape as the theme roles). */
type Styler = (text: string) => string

/** One observed run: first-observation clock plus cosmetic counters. */
interface RowRun {
	startedAt: number
	phase: string | undefined
	agentsStarted: number
	agentsSettled: number
}

/** Subscribe the five `workflow/*` events on `ctx` (cast pattern, driver-catalog posture). */
export function createWorkflowEventTap(ctx: Context): WorkflowEventTap & { dispose(): void } {
	const listeners = new Set<WorkflowTapListener>()
	const dispatch: WorkflowTapListener = (name, info, detail) => {
		for (const listener of listeners) listener(name, info, detail)
	}
	// Same `as Parameters<typeof rt.ctx.on>[0]` cast as driver-catalog.ts:248:
	// the events are declared in @deepseek-ai/dsh-workflow, which tui does not
	// import as a runtime dependency.
	const on = ctx.on.bind(ctx) as (event: string, listener: (...args: unknown[]) => void) => () => void
	const offs = SUBSCRIBED.map((name) => on(name, (...args: unknown[]) => {
		dispatch(name, args[0] as WorkflowRunInfo, args[1] as WorkflowEventDetail | undefined)
	}))
	return {
		on(listener) {
			listeners.add(listener)
			return () => { listeners.delete(listener) }
		},
		dispose() {
			listeners.clear()
			for (const off of offs) off()
		},
	}
}

/**
 * Create the workflow row: the second WorkingLine instance plus its run
 * tracker, subscribed to `driver.workflowEvents` when the driver provides the
 * tap (the cc-tui harness driver). Without the tap (compositions without the
 * harness driver seam) nothing subscribes and the row stays empty — an empty
 * `Text` collapses to zero lines and no interval is ever booked (start happens
 * on the first observed event only). Returns a disposer that unsubscribes and
 * stops the line (root destroy / driver dispose).
 */
export function attachWorkflowRow(
	driver: { workflowEvents?: WorkflowEventTap },
	spinnerColorFn: Styler,
	messageColorFn: Styler,
	onDirty: () => void,
): { line: WorkingLine; dispose(): void } {
	// Insertion-ordered: the last entry is the most recently started active run.
	const runs = new Map<string, RowRun>()
	const line = new WorkingLine(
		spinnerColorFn,
		messageColorFn,
		() => {
			// Most recently started still-active run (Map preserves insertion order).
			const entry = [...runs][runs.size - 1]
			if (entry === undefined) return ''
			const run = entry[1]
			const more = runs.size - 1
			const suffix = more > 0 ? ` · +${more} more` : ''
			return `running ${formatElapsed(Date.now() - run.startedAt)} · phase ${run.phase ?? '…'} · agents ${run.agentsSettled}/${run.agentsStarted}${suffix}`
		},
		onDirty,
	)

	const tap = driver.workflowEvents
	const unsubscribe = tap?.on((name, info, detail) => {
		// Per-event try/catch: a malformed payload freezes cosmetics at worst.
		try {
			// An event without a string run id is malformed: skip it entirely —
			// tracking it would start a bogus row no paired end ever clears.
			if (info === undefined || typeof info.id !== 'string' || info.id.length === 0) return
			const id = info.id
			if (name === 'workflow/end') {
				if (!runs.delete(id)) return
				if (runs.size === 0) line.stop()
				return
			}
			let run = runs.get(id)
			if (run === undefined) {
				// Unknown run id (resume-mid-run): the row appears on this first
				// observed event, elapsed counted from it — cosmetic understatement.
				run = { startedAt: Date.now(), phase: undefined, agentsStarted: 0, agentsSettled: 0 }
				runs.set(id, run)
				line.start()
			}
			if (name === 'workflow/phase') run.phase = typeof detail === 'string' ? detail : run.phase
			else if (name === 'workflow/agent-start') run.agentsStarted++
			else if (name === 'workflow/agent-end') run.agentsSettled++
		} catch {
			// Freeze cosmetics; the next well-formed event resumes updates.
		}
	})

	return {
		line,
		dispose() {
			unsubscribe?.()
			runs.clear()
			line.stop()
		},
	}
}
