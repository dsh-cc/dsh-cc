# VWA lane-2 Hardening — Feature F: CI Tool Schema Regression Gate

## Status: Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes); user sign-off pending.

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problem 12 from the tui-40b4 session.
Dependencies: None.

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature F: CI Schema Regression Gate

### F.1 Problem

PR #262 fixed the immediate schema bypass (defineTool wrap + warn-only
tripwire + tool-schema.spec.ts for vwa-argument's five tools). But there is
no CI-level gate that catches the whole class: any tool package that
registers with a non-JSON-Schema parameters object will degrade silently
to `{}` on the model side. The warn-only tripwire (runtime-registry.ts:35-42)
logs at runtime but does not fail CI.

### F.2 Design

Add a static CI check that verifies every registered tool across all
first-party packages has a valid, non-degenerate JSON Schema in its
`parameters` field.

**F.2.1 Vitest-based cross-package gate.**

A new test file `packages/core/tools/tests/tool-schema-gate.spec.ts` that:

1. Maintains a manifest of first-party tool-registering packages:

   ```ts
   const TOOL_PACKAGE_MANIFEST: Record<string, {
     importPath: string    // relative to the test file
     registerFn: string    // exported function name
     mount: (registry: { tools: { register: (def: ToolDefinition) => void } }) => void
   }> = {
     '@dsh-cc/vwa-argument': {
       importPath: '../../../interaction/vwa-argument/src/tools.ts',
       registerFn: 'registerArgumentTools',
       mount: (registry) => {
         const mod = await import('../../../interaction/vwa-argument/src/tools.ts')
         mod.registerArgumentTools(registry, {
           workspaceRoot: () => '/tmp',
           captures: new CaptureRegistry(),
           artifactTexts: new Map(),
           snapshotTexts: new Map(),
           maxEntities: 10000,
         })
       },
     },
     // ... other packages
   }
   ```

   The `mount` function uses `import()` (not `require()`) because the test
   is a vitest spec that runs in a TypeScript-aware environment. The
   `registry` parameter is a CaptureRegistry-shaped object with a
   `tools.register` method — matching the actual registration API
   (tools.ts:137-139).

   The manifest is maintained manually. A coverage check verifies the
   manifest against a glob of `packages/**/src/**/*.ts` for `tools.register(`
   or `defineTool(` calls: any file matching whose package is NOT in the
   manifest causes the test to fail with "package X not in
   TOOL_PACKAGE_MANIFEST".

2. For each package in the manifest, mounts its tools against a
   CaptureRegistry and asserts for each registered tool:
   - `definition.parameters` is defined (not undefined/null).
   - `definition.parameters.type === 'object'`.
   - `definition.parameters.properties` is a non-empty object (unless the
     tool genuinely takes no arguments — a whitelist of no-arg tools).
   - `assertSupportedJsonSchema(definition.parameters)` does not throw.

3. The test runs in the existing vitest suite — no new CI job needed.

**F.2.2 Package scope.**

The manifest covers first-party packages that register model-facing tools.
The glob check ensures no package is missed. Packages that register tools
but are NOT in the monorepo (MCP servers, user plugins loaded at runtime)
are explicitly out of scope — the runtime tripwire is the only gate for
those.

Known tool-registering packages (from a survey of `tools.register(` and
`defineTool(` calls):

- `@dsh-cc/vwa-argument` (registerArgumentTools — includes evidence.register,
  evidence.search_log, argument.update, argument.review, argument.report)
- `@dsh-cc/tools` (core tool definitions)
- `packages/core/tool-*/` packages (tool-web-fetch, tool-sleep, etc.)
- `packages/workspace/tool-git-worktree`
- `packages/memory/memory`
- `packages/subagent/task`, `packages/subagent/handoff-store`
- `packages/context/context-crusher`
- `packages/mcp/mcp-client` (excluded from assertions — MCP tools are
  external; the manifest entry asserts only that the registration function
  exists)

**F.2.3 Tripwire hardening in test mode.**

When `process.env.VITEST` is set, the warn-only tripwire in
runtime-registry.ts becomes a hard error. This means any package test that
mounts tools will fail at boot if a parameters schema is invalid.

**Fixture migration**: existing tests that register tools with degenerate
`parameters: {}` must be updated to use valid schemas or added to the
NO_ARG_TOOLS whitelist. A survey of existing test fixtures is required before
enabling the hard error. The survey is part of the implementation: run
`pnpm test` and fix every failure.

### F.3 Implementation

1. `packages/core/tools/tests/tool-schema-gate.spec.ts`: new vitest spec with
   manifest-based package discovery and per-tool schema assertions.
2. `packages/core/tools/src/runtime-registry.ts`: check `process.env.VITEST`
   in the tripwire; throw instead of warn.
3. Survey and fix existing test fixtures with degenerate parameters.

### F.4 Tests

The gate IS the test. The tripwire hardening is validated by running the
existing test suite and confirming no false positives (after fixture
migration).

---

---

## Review history for this feature

The design passed three-lane blind review (an internal critic seat plus
two external seats) over seven folding rounds. Cross-feature findings
(for example the shared cache-key and feasibility interactions between
Features A and C) were adjudicated in the combined draft; the per-round
ledger below lists the findings that touched this feature's sections.

### Round 1 (three-lane, v1 draft)
| Lane | Verdict | Key findings |
| Codex | NO-GO | A: missing requiredRules in cache key, arbitrary record selection. B: budget math wrong, config drift misclassified. C: currentReviews breaks with batching. D: cascade safety overstated. E: 30K threshold unsafe. F: coverage grep broken. |
| Grok | GO-WITH-CHANGES | A: continue-on-complete is silent skip. B: retry math respects wall-clock, truncation permanent. C: batching doesn't close gap, currentReviews breaks. D: need per-task errorDetail in report. E: structured data shouldn't be windowed. F: coverage glob wrong. |
| Critic | GO-WITH-CHANGES | A: record selection nondeterministic, disagreement skipped. B: rawResponse plumbing path wrong, use finish.failure. C: envelope targets collision, budget math false-positive. E: window evidence slices too. F: grep broken, exclude MCP/plugin. |
### Round 2 (three-lane delta, v2 draft)
| Lane | Verdict | Fold results | New issues |
### Round 3 (three-lane micro-confirmation, v3 draft)
| Lane | Verdict | Fold results | New issues |
### Round 4 (three-lane micro-confirmation, v4 draft)
| Lane | Verdict | Fold results | New issues |
### Round 5 (codex micro-confirmation, v5 draft)
| Lane | Verdict | Fold results | New issues |
### Round 6 (codex micro-confirmation, v5 updated)
| Lane | Verdict | Fold results |
### Round 7 (codex micro-confirmation, v5 final)
| Lane | Verdict | Fold results |

**Convergence**: seven rounds; the final reviewed draft carries every
folded finding. The full three-lane ledger is preserved in the session
records (`.scratch/vwa-enhancement-design-v5.md` history).
