/**
 * Entry ids the /provider bridge writes through `configEditor` (migration
 * plan Q3 addendum). Split out so the bridge and its pinning specs share the
 * ids without importing the runtime modules (avoids an import cycle).
 * @module @dsh-cc/tui/bridge-ids
 */

/** The rc.2 pi-ai adapter's entry row (its Config owns `providers`). */
export const PROVIDER_ENTRY_ID = 'llm-pi-ai'

/** The rc.2 agent-default-model entry row (its Config owns provider/model). */
export const DEFAULT_MODEL_ENTRY_ID = 'agent-default-model'
