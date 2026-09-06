/**
 * Upstream scheduler symbol binding, isolated as a leaf module so neither the
 * package barrel nor Code Mode needs to import runtime values from the other.
 * @module @dsh-cc/tools/src/scheduler
 */

import { createRequire } from 'node:module'

declare const upstreamSchedulerSymbol: unique symbol

/**
 * Scheduler entry point omitted from the generated named service API.
 * The value MUST be the upstream symbol instance: the in-box agent loop reads
 * the staged scheduler off the registry through the symbol exported by
 * `@deepseek-ai/dsh-tools`, and a `Symbol()` is identity-unique — minting a
 * private one here leaves the loop reading `undefined` and crashing every
 * turn's first tool call (`undefined.prepare`). The binding is a type-erased
 * `createRequire` rather than a static import so upstream's declaration graph
 * (its own `Context` augmentation, whose vendored copy this package also
 * ships) never enters downstream type programs; the dependency stays
 * runtime-only (peer-declared).
 * @internal
 */
export const TOOL_RUNTIME_SCHEDULER: typeof upstreamSchedulerSymbol = (
  createRequire(import.meta.url)('@deepseek-ai/dsh-tools') as { TOOL_RUNTIME_SCHEDULER: typeof upstreamSchedulerSymbol }
).TOOL_RUNTIME_SCHEDULER
