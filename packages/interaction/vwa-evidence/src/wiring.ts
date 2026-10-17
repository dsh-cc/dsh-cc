/**
 * Live wiring for the vwa-evidence turn-stopping evaluator (design §4.5):
 * registers the SYNCHRONOUS-dispatch `agent/turn-stopping` listener (the
 * harness awaits `dispatch.serial`, so the async gate run still lands before
 * the turn ends — the sync inject must precede the handler's return for the
 * same-turn continuation, completion-gate wiring.ts:128-152 precedent).
 *
 * Settings hot-read plane: the handler re-reads the raw
 * `<dshHome>/settings.json` per dispatch (evaluate-time, NOT apply-time —
 * §4.4); the namespace registration in apply is /config UX only. Gates run
 * through the harness ShellExecutor (`ctx.shell`, the post-edit-verify seam,
 * §4.3): the adapter resolves a one-shot foreground request and projects
 * `{exitCode, stdout.text, stderr.text}` onto the gates' Executor face.
 *
 * Fail-soft: every failure is caught and debug-logged; the turn loop is
 * never disturbed, and an abort discards the round without a receipt (§4.5).
 *
 * @module @dsh-cc/vwa-evidence/wiring
 */

import type { ShellExecRequest, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import { DEFAULT_GATE_TIMEOUT_MS, type Executor } from './gates.ts'
import {
  createEvaluatorState,
  evaluateTurnStopping,
  type EvaluatorState,
} from './evaluator.ts'
import { DEFAULT_VWA_EVIDENCE_SETTINGS, readUserSettingsSync, type VwaEvidenceSettings } from './settings.ts'
import { resolveDeliveryProvider } from './vwa-delivery.ts'

/** Adapter: gates' Executor face over the harness ShellExecutor (§4.3 seam). */
export function shellExecutorOf(shell: ShellExecutor): Executor {
  return async (cmd, args, cwd) => {
    const request: ShellExecRequest = {
      command: [cmd, ...args.map(shellQuote)].join(' '),
      workdir: cwd,
      timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      stdoutMaxBytes: 256 * 1024,
    }
    const execution = await shell.execute(shell.resolve(request))
    const result = await execution.result()
    return { code: result.exitCode ?? -1, stdout: result.stdout.text, stderr: result.stderr.text }
  }
}

/** POSIX single-quote wrapping; the gate arguments are repo-local paths/flags. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Injectable collaborators (tests duck-type these). */
export interface VwaDeps {
  /** Per-dispatch settings read (the hot path; wired to readUserSettingsSync). */
  readSettings(): VwaEvidenceSettings
  dshHome: string | undefined
  workspaceRoot(agent: unknown): string | undefined
  exec: Executor
  state: EvaluatorState
  debug(message: string): void
  /**
   * The vwa-argument delivery provider (§16.2), resolved per dispatch via
   * cordis duck-typing (§3 cycle-break; the service may mount after this
   * plugin). Undefined ⇒ lane-1-only turns.
   */
  deliveryProvider?(): unknown
}

/** Create the `agent/turn-stopping` handler. Never throws into the loop. */
export function createTurnStoppingHandler(deps: VwaDeps) {
  return async (payload: { agent: unknown; turn: number; signal?: AbortSignal }): Promise<void> => {
    try {
      const agent = payload.agent as Parameters<typeof evaluateTurnStopping>[0]['agent']
      const workspaceRoot = deps.workspaceRoot(agent)
      if (workspaceRoot === undefined) return
      await evaluateTurnStopping({
        agent,
        turn: payload.turn,
        settings: deps.readSettings(),
        workspaceRoot,
        exec: deps.exec,
        dshHome: deps.dshHome,
        state: deps.state,
        debug: deps.debug,
        signal: payload.signal,
        // Hot per-dispatch resolution, duck-typed — no package import (§3).
        deliveryProvider: resolveDeliveryProvider(deps.deliveryProvider?.(), workspaceRoot),
      })
    } catch (error: unknown) {
      deps.debug(`vwa-evidence: turn-stopping handler failed: ${String(error)}`)
    }
  }
}

/** Guarded dshHome read (completion-gate wiring.ts:37-43 pattern). */
function dshHomeOf(ctx: import('@deepseek-ai/cordis').Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

/**
 * Register the turn-stopping listener. Always registers; `exec` falls back
 * to a rejecting executor when no shell service exists (gate C then reports
 * `abstained` with detail — never `missing`, never silent).
 */
export function registerEvaluator(ctx: import('@deepseek-ai/cordis').Context, shell: ShellExecutor | undefined): void {
  const state = createEvaluatorState()
  const debug = (message: string) => {
    try {
      ctx.logger.debug(message)
    } catch {
      // Debug sink failures are swallowed by contract.
    }
  }
  const handler = createTurnStoppingHandler({
    readSettings: () => {
      const dshHome = dshHomeOf(ctx)
      return dshHome === undefined ? DEFAULT_VWA_EVIDENCE_SETTINGS : readUserSettingsSync(dshHome)
    },
    dshHome: dshHomeOf(ctx),
    workspaceRoot: (agent: unknown) => {
      try {
        return getSessionCwd(agent as never) ?? undefined
      } catch {
        return undefined
      }
    },
    exec: shell === undefined
      ? async () => {
          throw new Error('no shell service on the host context (§4.3 seam absent)')
        }
      : shellExecutorOf(shell),
    state,
    debug,
    deliveryProvider: () => ctx,
  })
  ctx.on('agent/turn-stopping', handler as never)
}
