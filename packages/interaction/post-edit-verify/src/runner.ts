/**
 * Shell-seam runner (design doc §3.3): run a matched verify rule through the
 * injected harness ShellExecutor (`resolve` → `run`), shape the appended
 * block, and own the per-rule burst timestamp map. Fail-soft: a run
 * rejection, a timeout, or a signal death appends nothing and logs debug.
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ShellExecRequest, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ToolExecution } from '@dsh-cc/tools'
import { burstLabel } from './burst.ts'
import { buildVerifyBlock } from './compose.ts'
import type { VerifyRule } from './rules.ts'
import type { RulesSettings } from './settings.ts'

/** Per-rule timeout default when the rule sets none (doc §3.3). */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Hard cap on the per-rule timeout (doc §3.3). */
export const MAX_TIMEOUT_MS = 120_000

/**
 * Large request-side output budget: the executor caps output before us, so
 * tail+first-line truncation to `max-output-bytes` happens consumer-side with
 * full fidelity (doc §3.3).
 */
const REQUEST_STDOUT_MAX_BYTES = 256 * 1024

/** Clamp the rule's timeout: default 60 s, hard cap 120 s. */
export function clampTimeoutMs(rule: VerifyRule): number {
  return Math.min(rule.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/**
 * Keep at most `maxBytes` of captured output: ALWAYS the first line plus the
 * tail (exit narratives live at the tail). Empty stderr is dropped.
 */
export function keepOutput(stdout: string, stderr: string, maxBytes: number): string {
  const parts = [stdout, stderr]
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
  const text = parts.join('\n')
  if (Buffer.byteLength(text) <= maxBytes) return text
  const lines = text.split('\n')
  const head = lines[0]!
  let tail = ''
  for (let i = lines.length - 1; i > 0; i--) {
    const candidate = tail === '' ? lines[i]! : `${lines[i]}\n${tail}`
    if (Buffer.byteLength(head) + Buffer.byteLength(candidate) + 2 > maxBytes) break
    tail = candidate
  }
  return tail === '' ? head : `${head}\n${tail}`
}

/** What one verify run contributes to the post-execute seam. */
export interface VerifyOutcome {
  /** The block to append; `undefined` when nothing may be appended. */
  block?: ContentBlock
  /** The executor's first-cause facts (pinned by the timeout probe test). */
  run?: { exitCode: number | null; timedOut: boolean }
  /** Why nothing was appended, for the caller's debug log. */
  skipped?: string
}

export interface RunnerOptions {
  shell: ShellExecutor
  logger: { debug(message: string): void }
  /** Millisecond clock (injected for tests). */
  now?: () => number
}

export interface Runner {
  /** Per-rule last-run timestamps (ruleKey = `${glob}\n${command}`). */
  readonly lastRunAt: ReadonlyMap<string, number>
  run(
    rule: VerifyRule,
    exec: Pick<ToolExecution, 'signal'>,
    settings: RulesSettings,
    sessionCwd?: string,
  ): Promise<VerifyOutcome>
}

/**
 * Build the verify runner. The burst map lives here, per mount: every
 * matching edit runs (no debounce skip) — the debounce window only labels.
 */
export function createRunner(options: RunnerOptions): Runner {
  const now = options.now ?? Date.now
  const lastRunAt = new Map<string, number>()

  async function run(
    rule: VerifyRule,
    exec: Pick<ToolExecution, 'signal'>,
    settings: RulesSettings,
    sessionCwd?: string,
  ): Promise<VerifyOutcome> {
    const started = now()
    const ruleKey = `${rule.glob}\n${rule.command}`
    const label = burstLabel(ruleKey, now(), lastRunAt.get(ruleKey), settings.debounceMs)
    lastRunAt.set(ruleKey, started)
    const request: ShellExecRequest = {
      command: rule.command,
      timeoutMs: clampTimeoutMs(rule),
      stdoutMaxBytes: REQUEST_STDOUT_MAX_BYTES,
      signal: exec.signal,
      ...(sessionCwd === undefined ? {} : { workdir: sessionCwd }),
    }
    let result: ShellRunResult
    try {
      result = await options.shell.run(options.shell.resolve(request))
    } catch (error: unknown) {
      // The executor rejects only on infra faults (unusable workdir, missing
      // shell). Append nothing — the edit result stays exactly as before.
      options.logger.debug(`post-edit-verify: "${rule.command}" failed to run: ${String(error)}`)
      return { skipped: 'run rejected' }
    }
    const durationMs = now() - started
    const facts = { exitCode: result.exitCode, timedOut: result.timedOut }
    if (result.timedOut) {
      options.logger.debug(`post-edit-verify: "${rule.command}" timed out after ${clampTimeoutMs(rule)}ms — appending nothing`)
      return { run: facts, skipped: 'timed out' }
    }
    if (result.exitCode === null) {
      options.logger.debug(`post-edit-verify: "${rule.command}" died by signal — appending nothing`)
      return { run: facts, skipped: 'signal death' }
    }
    const kept = keepOutput(result.stdout.text, result.stderr.text, settings.maxOutputBytes)
    const composed = buildVerifyBlock(rule.command, result.exitCode, durationMs, kept, settings.verboseOnSuccess)
    if (composed.type !== 'text') return { run: facts, skipped: 'unexpected block kind' }
    const text = composed.text
    const block: ContentBlock = { type: 'text', text: label === undefined ? text : `${text}\n${label}` }
    return { block, run: facts }
  }

  return { lastRunAt, run }
}
