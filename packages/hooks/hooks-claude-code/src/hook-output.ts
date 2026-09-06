/**
 * Decode subagent (non-process) hook results into the neutral `HookOutput`
 * vocabulary, plus the `$ARGUMENTS` prompt interpolation shared by the
 * prompt/agent executors. Split from index.ts for the line budget; the runtime
 * importer is dispatch.ts, and index.ts re-exports the public pair.
 * @module
 */

import type { HookOutput } from '@dsh-cc/hook-protocol'

/** A non-blocking hook error the subagent raised (StopFailure-style vocabulary). */
interface HookRunError {
  type: string
  message: string
}

/** Exact text values of `run.result.stopReason`. */
const STOP_REASON_ERROR = 'error'

/**
 * Interpolate the JSON hook input into a `prompt`/`agent` template. The CC spec
 * feeds hook input to prompt hooks as JSON; here the payload is embedded via
 * `$ARGUMENTS` when the template names it, otherwise appended after a blank line.
 */
export function interpolatePrompt(template: string, payload: unknown): string {
  const json = typeof payload === 'string' ? payload : JSON.stringify((payload ?? {}) as unknown)
  return template.includes('$ARGUMENTS')
    ? template.split('$ARGUMENTS').join(json)
    : `${template}\n\n${json}`
}

/**
 * Decode a forked subagent's result into a neutral {@link HookOutput}. Unlike
 * {@link parseHookOutput} (which consumes process stdout/stderr/exitCode), a
 * subagent has no process channels — this concatenates its text blocks, then
 * tries to parse them as a recognized HookOutput JSON object. A parse failure
 * yields an empty (non-blocking) output and warns in debug; `stopReason: 'error'`
 * surfaces as a non-blocking hook error, matching command-hook error semantics.
 * @param result - the fork's terminal result.
 * @param debug - the bridge logger's debug sink for the parse-failure warn.
 * @returns the decoded output.
 */
export function contentToHookOutput(
  result: { stopReason: string; content: readonly { type: string; text?: string }[] },
  debug: (message: string) => void,
): { output: HookOutput; error?: HookRunError } {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (result.stopReason === STOP_REASON_ERROR) {
    return { output: emptyHookOutput(), error: { type: 'error', message: text || 'subagent hook failed' } }
  }
  const output = emptyHookOutput()
  let parsed: Record<string, unknown> | undefined
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    if (text.length > 0) debug(`hooks-claude-code: prompt/agent hook produced non-JSON text (treated as empty output)`)
  }
  if (parsed !== undefined) applyContentOutput(output, parsed)
  return { output }
}

/** A neutral output for a non-process executor (no exit code or stdin/stdout). */
export function emptyHookOutput(): HookOutput {
  return { exitCode: undefined, stderr: '', stdout: '' }
}

/** Fold a parsed JSON object into `output`, mirroring the codec's structured-field vocabulary. */
function applyContentOutput(output: HookOutput, parsed: Record<string, unknown>): void {
  const str = (obj: Record<string, unknown>, key: string): string | undefined => typeof obj[key] === 'string' ? obj[key] as string : undefined
  const bool = (obj: Record<string, unknown>, key: string): boolean | undefined => typeof obj[key] === 'boolean' ? obj[key] as boolean : undefined
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  // Top-level legacy fields (CC only allows approve/block at top level).
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const sysMsg = str(parsed, 'systemMessage')
  if (sysMsg !== undefined) output.systemMessage = sysMsg
  const topDecision = str(parsed, 'decision')
  if (topDecision === 'approve' || topDecision === 'block') output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  // The per-event hookSpecificOutput channel (permissionDecision/additionalContext…).
  const hso = obj(parsed.hookSpecificOutput)
  if (hso !== undefined) {
    const eventName = str(hso, 'hookEventName')
    if (eventName !== undefined) output.hookEventName = eventName
    const permissionDecision = str(hso, 'permissionDecision')
    if (permissionDecision === 'allow' || permissionDecision === 'deny' || permissionDecision === 'ask') {
      output.decision = permissionDecision
    }
    const permissionReason = str(hso, 'permissionDecisionReason')
    if (permissionReason !== undefined) output.reason = permissionReason
    const additionalContext = str(hso, 'additionalContext')
    if (additionalContext !== undefined) output.additionalContext = additionalContext
    const updated = obj(hso.updatedInput)
    if (updated !== undefined) output.updatedInput = updated
  }
}
