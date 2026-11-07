/**
 * Host-side application of an alias-stamped reasoning effort (harness-0.2.2
 * D3.6: the stamp is applied DURABLY at child publication — the request-time
 * overlay is gone, step-fatally rejected upstream).
 *
 * Named CC subagents carry `reasoningEffort` on their child options as an
 * undeclared runtime extra key (stamped by the Task tool / plugin-loader when
 * the spawn's alias resolved with one). A fork-seed child restores an
 * explicit parent `/effort` through the seeded log prefix (S4 probe:
 * `AgentModel.current()` reports the restored effort, not the stamp), so the
 * `subagent/start` listener in the routes service selects the stamp onto the
 * child's live selection — the alias contract wins.
 *
 * @module @dsh-cc/model-aliases/effort
 */

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
