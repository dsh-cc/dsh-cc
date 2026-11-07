/**
 * TEST SUPPORT — the retired append-order helper, preserved as a documented
 * contract of the past.
 *
 * DeepSeek's context cache keys on the request prefix, so the position of a
 * tool schema in the assembled `tools` array decides whether activating one
 * more tool preserves or invalidates the cached prefix. Until harness
 * 0.2.2-rc.1 the `@dsh-cc/tool-append-order` plugin owned that order: it hooked
 * the public `system-prompt/assemble` waterfall, remembered the sequence it
 * last emitted per scope, kept surviving tools at their remembered positions,
 * and appended newly appeared ones lexicographically at the tail (the steady
 * state was "append-only": activations extended the tool list instead of
 * shifting it).
 *
 * That seam is GONE: `PromptPresentation` no longer carries `tools`, and
 * `orderTools` canonicalizes the collected catalog BEFORE the waterfall runs.
 * Ordering is now constructor state on the host `SystemPrompt` service, so the
 * deployment configures `toolOrder` (see `packages/bundle/cc-shell/cordis.patch.yml`)
 * with the frozen always-registered catalog and accepts one behavior delta:
 * the unlisted rest bucket is re-sorted lexicographically on every assembly, so
 * a newly visible unlisted tool INSERTS there instead of appending at the tail.
 * The static prefix (the dominant cache-stability surface) is unchanged.
 *
 * These exports keep the old algorithm and its per-scope memory alive as
 * executable documentation: `tests/tool-order-contract-of-the-past.spec.ts`
 * pins the past contract so a future reader can see exactly what changed. No
 * production code imports this module.
 *
 * @module @dsh-cc/tools/test-support
 */

/** The minimum a tool schema must expose to be ordered. */
export interface NamedSchema {
  readonly name: string
}

/**
 * Reorder `incoming` so the remembered sequence survives in place and new
 * tools append lexicographically at the tail. A name in `previous` that no
 * longer appears is dropped; a duplicate name in `incoming` keeps its first
 * schema — the exact retired plugin behavior.
 * @param previous - the tool names this memory last emitted for the scope.
 * @param incoming - the harness-assembled tools (lexicographic baseline).
 * @returns the stabilized tool array.
 */
export function appendStable<T extends NamedSchema>(previous: readonly string[], incoming: readonly T[]): T[] {
  const unconsumed = new Map<string, T>()
  for (const tool of incoming) {
    if (!unconsumed.has(tool.name)) unconsumed.set(tool.name, tool)
  }
  const ordered: T[] = []
  for (const name of previous) {
    const tool = unconsumed.get(name)
    if (tool !== undefined) {
      ordered.push(tool)
      unconsumed.delete(name)
    }
  }
  const appended = [...unconsumed.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [...ordered, ...appended]
}

/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The retired plugin's per-scope sequence memory, as a standalone helper.
 *
 * The first ordering of a scope passes the harness baseline through untouched
 * (and records it); later orderings keep the remembered sequence and append
 * new names at the tail. The retired plugin keyed this memory by a
 * `WeakMap<ScopeKey, readonly string[]>` living inside its `apply`; the class
 * below is the same memory, instantiable from a spec.
 */
export class AppendStableMemory<K extends object = object> {
  private readonly lastEmitted = new WeakMap<K, readonly string[]>()

  /**
   * Order one scope's tools, recording the emitted sequence.
   * @param scope - scope key whose sequence is remembered (a ScopeKey at runtime).
   * @param incoming - the harness-ordered tools for this assembly.
   * @returns the stabilized array (the same array on a scope's first assembly).
   */
  order<T extends NamedSchema>(scope: K, incoming: readonly T[]): readonly T[] {
    const previous = this.lastEmitted.get(scope)
    const ordered = previous === undefined ? incoming : appendStable(previous, incoming)
    this.lastEmitted.set(scope, ordered.map(tool => tool.name))
    return ordered
  }

  /** The sequence last emitted for `scope`, if any — inspection for specs and docs. */
  emitted(scope: K): readonly string[] | undefined {
    return this.lastEmitted.get(scope)
  }
}

/** The harness baseline order a scope's first assembly would take. */
export function sortedNames<T extends NamedSchema>(tools: readonly T[]): string[] {
  return tools.map(tool => tool.name).sort(compareNames)
}
