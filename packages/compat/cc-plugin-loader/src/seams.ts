/**
 * Optional host seams a CC plugin loader mounts onto, plus the structural
 * report accumulator.
 *
 * The loader is deliberately peer-style: it consults each component's host
 * seam through `ctx.get(...)` and skips (with a reason) rather than throwing
 * when a seam is absent, so a deployment can mount a plugin without every
 * extension point present. `mcp` and `hooks` have no harness-owned service
 * today; this module declares their guest contract so a host can satisfy it.
 *
 * @module
 */

import type { ComponentKind, ComponentResult } from './types.ts'

/** A guest MCP seam: registers one named server for tool discovery. */
export interface McpSeam {
  /**
   * Register one MCP server. The server-qualified public tool names
   * (`mcp__<server>__<tool>`) are the seam's naming responsibility.
   * @param name - unique server name.
   * @param config - server transport configuration.
   * @returns the exact disposer that unregisters the server.
   */
  registerServer(name: string, config: Record<string, unknown>): () => void
}

/** A guest hooks seam: injects a plugin's Claude Code hooks. */
export interface HooksSeam {
  /**
   * Merge a plugin's translated hooks into the bridge. The value is the
   * canonical `ClaudeCodeHookConfig` shape the bridge consumes.
   * @param pluginName - the plugin owning the hooks, for namespacing.
   * @param config - the parsed per-event `MatcherGroup[]` map.
   * @param pluginRoot - the plugin's root dir, used to substitute
   *   `${CLAUDE_PLUGIN_ROOT}` in command strings.
   * @returns the exact disposer that removes the injected hooks.
   */
  mergePluginHooks(pluginName: string, config: unknown, pluginRoot?: string): () => void
}

/** Probe a guest seam by key, returning `undefined` when the host lacks it. */
export function probe<X>(value: X | undefined): X | undefined {
  return value
}

/** Accumulates loaded/skipped/failed counts and reasons for one component. */
export class ComponentTally {
  private loaded = 0
  private skipped = 0
  private failed = 0
  private readonly reasons: string[] = []

  /**
   * Construct a tally for one component kind.
   * @param kind - the component this tally measures.
   */
  constructor(private readonly kind: ComponentKind) {}

  /** Record one component as mounted. */
  addLoaded(): void {
    this.loaded += 1
  }

  /** Record one component as skipped, with the reason. */
  addSkipped(reason: string): void {
    this.skipped += 1
    this.reasons.push(reason)
  }

  /** Record one component as failed, with the reason. */
  addFailed(reason: string): void {
    this.failed += 1
    this.reasons.push(reason)
  }

  /** Build the final per-component result. */
  result(): ComponentResult {
    return {
      kind: this.kind,
      loaded: this.loaded,
      skipped: this.skipped,
      failed: this.failed,
      reasons: this.reasons,
    }
  }
}
