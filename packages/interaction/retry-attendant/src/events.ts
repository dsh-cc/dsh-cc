/**
 * Session event registration for the retry-attendant telemetry event.
 *
 * `wiring.ts` appends `retry-attendant/event` rows into the session log.
 * The jsonl persistence backend refuses to reopen any session that contains
 * an event type outside `KNOWN_SESSION_EVENT_TYPES`
 * (SessionFormatUnsupportedError on open(read|write)), so the type MUST be
 * registered into the live set at module load — the same idiom as
 * `@dsh-cc/session-cwd` / `@dsh-cc/completion-gate`. Without this, every
 * session that ever fired one retry guidance becomes permanently
 * unresumable (the "last session is no longer valid" boot failure).
 *
 * Coupling (accepted, precedent-consistent): the registration is an
 * unconditional module-load side effect — never gated by the feature's
 * enabled flag — and the type string must never be renamed.
 *
 * @module
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Log-only dogfood telemetry event (payload shape: `types.ts`). */
export const RETRY_ATTENDANT_EVENT = 'retry-attendant/event'

// The set is typed ReadonlySet but is a live Set — same registration idiom
// as session-cwd; see the module doc for why this must stay unconditional.
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(RETRY_ATTENDANT_EVENT)
