/**
 * Session event registration for the Code Mode dispatch telemetry events.
 *
 * `code-mode.ts` appends `tool/code-dispatch-start` / `tool/code-dispatch`
 * rows into the session log. The jsonl persistence backend refuses to
 * reopen any session that contains an event type outside
 * `KNOWN_SESSION_EVENT_TYPES` (SessionFormatUnsupportedError on
 * open(read|write)), so both types MUST be registered into the live set at
 * module load — the same idiom as `@dsh-cc/session-cwd` /
 * `@dsh-cc/completion-gate`. Without this, any session that ran a `run_code`
 * program with a nested dispatch becomes permanently unresumable.
 *
 * Coupling (accepted, precedent-consistent): the registration is an
 * unconditional module-load side effect, and the type strings must never be
 * renamed.
 *
 * @module
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** One sub-dispatch STARTING inside a `run_code` program (payload: `types.ts`). */
export const CODE_DISPATCH_START_EVENT = 'tool/code-dispatch-start'

/** One sub-dispatch SETTLING inside a `run_code` program (payload: `types.ts`). */
export const CODE_DISPATCH_EVENT = 'tool/code-dispatch'

// The set is typed ReadonlySet but is a live Set — same registration idiom
// as session-cwd; see the module doc for why this must stay unconditional.
for (const type of [CODE_DISPATCH_START_EVENT, CODE_DISPATCH_EVENT]) {
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(type)
}
