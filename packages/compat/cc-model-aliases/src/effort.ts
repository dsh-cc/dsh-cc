/**
 * Host-side application of an alias-stamped reasoning effort.
 *
 * Named CC subagents carry `reasoningEffort` on their child options as an
 * undeclared runtime extra key (stamped by the Task tool / plugin-loader when
 * the spawn's alias resolved with one). `buildRequest` deep-freezes its seed
 * config and the fork may have restored an explicit parent `/effort` from the
 * seed `request/header` — the alias contract must win — so the host
 * `agent/request` listener in the routes service overlays the stamp AFTER
 * `next()` via this helper.
 *
 * The overlay is a shallow copy: assigning onto the resolved config in place
 * throws on the frozen seed or is invisible. Any absent/blank/non-string
 * stamp is a no-op returning the input unchanged.
 *
 * @module @dsh-cc/model-aliases/effort
 */

/**
 * Overlay an alias-stamped reasoning effort onto one resolved request config.
 * @param resolved - the config produced by the `agent/request` waterfall.
 * @param stamped - the effort read off the child agent's options (any type;
 *   only a non-empty string applies).
 * @returns a shallow copy carrying the stamp, or the input unchanged when the
 *   stamp is absent/blank/non-string.
 */
export function overlayStampedEffort<T extends { reasoningEffort?: unknown }>(resolved: T, stamped: unknown): T {
  if (typeof stamped !== 'string' || stamped.length === 0) return resolved
  // Stamp is an opaque adapter spelling; the branded `ReasoningEffortId` on
  // LlmCallConfig is applied at prepareCall, not here.
  return { ...resolved, reasoningEffort: stamped } as T
}

/**
 * Read the effort stamp off a child agent's options. The stamp is an
 * undeclared runtime extra key (`AgentOptions` is merge-extensible and the
 * harness only copies provider/model/maxTokens into `child.options` through
 * its own spread — extra keys survive). Treats the options as unknown: a
 * non-string or absent value yields `undefined`.
 * @param options - the agent's `options` object (untyped on purpose).
 * @returns the stamped effort string, or undefined.
 */
export function stampedEffortOf(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const effort = (options as { reasoningEffort?: unknown }).reasoningEffort
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined
}
