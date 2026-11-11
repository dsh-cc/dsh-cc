/**
 * The upstream PTC SDK renderers, loaded at runtime with locally-owned types.
 *
 * WHY THIS MODULE EXISTS — the import cannot be a static `import` statement:
 *
 * The upstream barrel's `.d.ts` chain transitively loads the upstream
 * `@deepseek-ai/dsh-tools` declaration file, which contains
 * `declare module '@deepseek-ai/cordis' { interface Context { tools: … } }`.
 * This fork's own `src/index.ts` declares the SAME augmentation with the
 * fork's `ToolsService` (upstream's surface plus `reserve` / `isAdmitted` /
 * `restrictableNames`). Once both declarations are in one program,
 * `skipLibCheck` merges them silently and the upstream one wins — every
 * `ctx.tools` assignment and the executor's `ToolExecutor` conformance then
 * fail (TS2739/TS2345). This is the same blocker class that keeps the vendored
 * settings provider from importing `@deepseek-ai/dsh-settings` (TS2717
 * there): a fork cannot co-load the upstream package's declaration universe
 * when both sides augment the same context property with nominally different
 * types.
 *
 * THE LOAD MECHANISM: a dynamic `import()` whose specifier is widened to
 * `string` — TypeScript does not resolve (and therefore does not load the
 * declarations of) a non-literal dynamic import, while Node resolves the
 * real package at runtime exactly as a static import would. Top-level `await`
 * (this package is ESM, target es2024) makes the functions available before
 * any importer's code runs, so the synchronous `renderSdk` path needs no
 * lazy-init handling. The module's surface is then cast to the locally-owned
 * function types below.
 *
 * DRIFT OWNERSHIP: the types in this file must be reviewed whenever the
 * harness pin moves. The runtime contract is additionally pinned by tests —
 * `tests/sdk-render-parity.spec.ts` renders the frozen catalog through these
 * functions byte-for-byte against committed snapshots, so a signature or
 * output change upstream cannot land here silently.
 *
 * @module @dsh-cc/tools/ptc-renderers
 */

import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import type { ToolSdkSchema } from './sdk-schema.ts'

export type { ToolSdkSchema } from './sdk-schema.ts'

/** The typed surface this fork consumes from the upstream package. */
interface PtcRenderers {
  /** Map one JSON-Schema node to a context-free TypeScript type expression. */
  jsonSchemaToTs: (schema: unknown) => string
  /** Map one JSON-Schema node to a context-free Python type expression. */
  jsonSchemaToPy: (schema: unknown) => string
  /** Render the full TypeScript SDK prompt section. */
  renderToolsSdk: (schemas: readonly ToolSdkSchema[], programFormat?: PtcProgramFormat) => string
  /** Render the full Python SDK prompt section. */
  renderToolsSdkPy: (schemas: readonly ToolSdkSchema[]) => string
}

// Widened ON PURPOSE: a literal-typed specifier would make TypeScript resolve
// the package declarations and re-introduce the augmentation collision above.
const specifier: string = '@deepseek-ai/dsh-tool-executor-ptc'
const upstream = await import(specifier) as unknown as PtcRenderers

export const jsonSchemaToTs = upstream.jsonSchemaToTs
export const jsonSchemaToPy = upstream.jsonSchemaToPy
export const renderToolsSdk = upstream.renderToolsSdk
export const renderToolsSdkPy = upstream.renderToolsSdkPy

/**
 * Remove `$schema` annotation keys from a JSON-Schema-shaped value before it
 * reaches the upstream renderers — the SDK-path continuation of the fork's
 * D2.1 annotation tolerance. The upstream validator does not list `$schema`
 * as an annotation keyword, so a node carrying one fails its subset check
 * and degrades to `unknown` (TS) / `Any` (Python); but the MCP SDK's zod
 * conversion emits `$schema` on every external server schema, and mcp-client
 * registers those schemas verbatim as tool parameters. Only this boundary
 * strips; the stored tool schemas keep whatever annotations they carry.
 *
 * Iterative with an explicit stack: tool output schemas are exercised at
 * 5,000-deep unions (code-mode's deep_output case), where a recursive walk
 * overflows.
 * @param node - a detached JSON-Schema-shaped value.
 * @returns a copy with every `$schema` key removed, at any depth.
 */
export function stripSchemaAnnotations<T>(node: T): T {
  if (typeof node !== 'object' || node === null) return node
  type Container = Record<string, unknown> | unknown[]
  const root: Container = Array.isArray(node)
    ? [...(node as unknown[])]
    : { ...(node as Record<string, unknown>) }
  const pending: Container[] = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const value = current[index]
        if (typeof value === 'object' && value !== null) {
          const copy: Container = Array.isArray(value)
            ? [...(value as unknown[])]
            : { ...(value as Record<string, unknown>) }
          current[index] = copy
          pending.push(copy)
        }
      }
      continue
    }
    for (const key of Object.keys(current)) {
      if (key === '$schema') {
        delete current[key]
        continue
      }
      const value = current[key]
      if (typeof value === 'object' && value !== null) {
        const copy: Container = Array.isArray(value)
          ? [...(value as unknown[])]
          : { ...(value as Record<string, unknown>) }
        current[key] = copy
        pending.push(copy)
      }
    }
  }
  return root as T
}
