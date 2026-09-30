import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

const agentCordisPath = new URL('../agent.cordis.yml', import.meta.url).pathname
const presetYmlPath = new URL('../preset.yml', import.meta.url).pathname
const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const yamlText = readFileSync(agentCordisPath, 'utf8')
const doc = yaml.load(yamlText, { schema: entryListSchema }) as any[]

const BASE_IDS = [
  'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs',
  'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
]

// The standard-preset anchor for the drift gate, re-pointed for harness
// 0.1.7-rc.2 (G15): the old `apps/cli/config/agent-presets/standard/` tree is
// deleted. The live upstream composition is now the web-app bundle's
// declaration row: `packages/bundle/web-app/presets/standard.patch.yml` — a
// patch (an `insert` list) holding one `@deepseek-ai/dsh-agent-preset` row
// whose `config.plugins` IS the standard entry list. We align with whichever
// upstream is CURRENTLY linked/installed rather than pinning a version, so
// the gate tracks the real upstream. A missing anchor is a hard failure: the
// old silent skip disabled the safety check it existed for.
interface AnchorPreset {
  /** Absolute path to the upstream `standard.patch.yml` declaration. */
  file: string
  /** Human-readable origin, used in gate failure messages. */
  source: string
}

// tier-1: the linked upstream checkout. `@deepseek-ai/cordis-plugin-include` is
// symlinked (via node_modules) into the deepseek-harness repo's vendor/include/,
// so walking up from its package.json — never a relative path, which breaks in
// a worktree layout — finds the standard preset declaration in that checkout.
function resolveLinkedAnchor(): AnchorPreset | undefined {
  try {
    const real = realpathSync(includePkg)
    let cur = dirname(real)
    for (let i = 0; i < 4; i++) {
      const cand = join(cur, 'packages', 'bundle', 'web-app', 'presets', 'standard.patch.yml')
      if (existsSync(cand)) {
        return { file: cand, source: `linked upstream checkout (${cur})` }
      }
      cur = dirname(cur)
    }
  } catch {
    // no linked checkout; fall through to tier-2
  }
  return undefined
}

// tier-2: an installed deployment at or above the vendored floor. Newest-mtime
// first across `~/.npm/_npx` npx-install dirs and the `~/.dsh/profiles` install.
// The web-app bundle ships its preset declarations (`presets/*.patch.yml`).
function resolveInstalledAnchor(): AnchorPreset | undefined {
  const floor = parseVendoredFloor(yamlText)
  const candidates: string[] = []
  const npxRoot = join(process.env.HOME ?? '', '.npm', '_npx')
  for (const entry of safeReaddir(npxRoot)) {
    const p = join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(p)) candidates.push(p)
  }
  const profilePkg = join(
    process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
  )
  if (existsSync(profilePkg)) candidates.push(profilePkg)

  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const p of candidates) {
    try {
      const version = JSON.parse(readFileSync(p, 'utf8')).version
      if (cmpVersion(version, floor) >= 0) {
        // A qualifying install whose layout lacks the declaration (or a future
        // rename) must fall through to the next candidate, not turn the
        // should-skip case into a readFileSync failure inside the test.
        const file = join(dirname(p), '..', 'dsh-web-app', 'presets', 'standard.patch.yml')
        if (!existsSync(file)) continue
        return {
          file,
          source: `deployment install (${p})`,
        }
      }
    } catch {
      // unreadable/invalid package.json; skip
    }
  }
  return undefined
}

/** Resolve the vendored floor from the header's `vendored from @deepseek-ai/dsh@X.Y.Z-rc.N`. */
function parseVendoredFloor(text: string): string | undefined {
  const m = text.match(/vendored from @deepseek-ai\/dsh@([\w.\-]+)/)
  return m ? m[1] : undefined
}

/** Compare semver `X.Y.Z-rc.N` as numeric tuples; malformed versions never match. */
function cmpVersion(a: string | undefined, b: string | undefined): number {
  const pa = parseVer(a)
  const pb = parseVer(b)
  if (!pa || !pb) return -1
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

const VER_RE = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/
function parseVer(v: string | undefined): number[] | undefined {
  if (!v) return undefined
  const m = v.match(VER_RE)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory())
  } catch {
    return []
  }
}

const anchor = resolveLinkedAnchor() ?? resolveInstalledAnchor()
if (!anchor) {
  // Hard failure, not a skip: with the anchor gone the gate protects nothing
  // and a silent skip would let baseline drift ship unnoticed (G15).
  throw new Error(
    '[composition] drift gate: no upstream standard-preset anchor found '
      + '(tier-1 linked checkout packages/bundle/web-app/presets/standard.patch.yml, '
      + 'tier-2 installed dsh-web-app); cannot verify the cc baseline',
  )
}

describe('agent.cordis.yml composition', () => {
  it('parses with the entryListSchema and carries string ids/names', () => {
    expect(Array.isArray(doc)).toBe(true)
    expect(doc.length).toBeGreaterThan(0)
    for (const row of doc) {
      expect(typeof row.id).toBe('string')
      expect(typeof row.name).toBe('string')
    }
    for (const row of doc) {
      if (row.name === 'cordis:group') {
        expect(row.group).toBe(true)
        expect(Array.isArray(row.config)).toBe(true)
      }
    }
  })

  it('has no duplicate top-level ids and keeps the 16 baseline rows', () => {
    const ids = doc.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const baseId of BASE_IDS) {
      expect(ids).toContain(baseId)
    }
  })

  it('ships a well-formed starter price table for command-cost', () => {
    const row = doc.find((r) => r.id === 'command-cost')!
    const table = (row.config as { modelTable: any[] }).modelTable
    expect(Array.isArray(table)).toBe(true)
    expect(table.length).toBeGreaterThan(0)
    const models = new Set<string>()
    for (const entry of table) {
      expect(typeof entry.model).toBe('string')
      expect(entry.model.length).toBeGreaterThan(0)
      expect(entry.model).not.toBe('*')
      expect(entry.provider).toBeUndefined()
      for (const key of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok']) {
        expect(typeof entry[key]).toBe('number')
        expect(entry[key]).toBeGreaterThanOrEqual(0)
      }
      // First exact match wins, so a duplicate model id would silently shadow
      // one of the columns.
      expect(models.has(entry.model)).toBe(false)
      models.add(entry.model)
    }
  })

  it('mounts cache-health as a plain command row with no preset config', () => {
    const row = doc.find((r) => r.id === 'cache-health')!
    expect(row.name).toBe('@dsh-cc/cache-health')
    // The plugin's default config (enabled: true) is all the preset needs; any
    // tuning belongs to deployments, not the preset row.
    expect(row.config).toBeUndefined()
  })

  it('isolates exactly the twelve cc-services services, hosting the commands and the ccModelRoutes consumers', () => {
    const group = doc.find((r) => r.id === 'cc-services')!
    expect(group.name).toBe('cordis:group')
    expect(group.isolate).toEqual({
      toolSearch: true,
      microcompactor: true,
      ccModelRoutes: true,
      resumePinStore: true,
      mcpConnections: true,
      hookBridgeStatus: true,
      mcp: true,
      hooks: true,
      rules: true,
      contextCrusher: true,
      compactionCostGate: true,
      ccActorContractGate: true,
    })
    const configIds = (group.config as any[]).map((r) => r.id)
    const topIds = doc.map((r) => r.id)
    // The handoff-store row (plan docs/plans/2026-09-10-subagent-handoff-store.md)
    // publishes no Service and sits inside the group, last among the tool rows
    // (after tool-web-fetch), with NO new isolate key (plain plugin, memory pattern).
    expect(configIds).toContain('handoff-store')
    expect(topIds).not.toContain('handoff-store')
    expect(configIds.indexOf('handoff-store')).toBeGreaterThan(configIds.indexOf('tool-web-fetch'))
    // The post-edit-verify row (plan docs/plans/2026-09-20-post-edit-auto-verify.md)
    // publishes no Service (plain plugin) and sits inside the group right after
    // tool-use-summary, with NO new isolate key; its post-execute listener is
    // registered WITHOUT prepend so context-crusher stays outermost.
    expect(configIds).toContain('post-edit-verify')
    expect(topIds).not.toContain('post-edit-verify')
    expect(configIds.indexOf('post-edit-verify')).toBeGreaterThan(configIds.indexOf('tool-use-summary'))
    // The edit-recovery-hint row (plan docs/plans/2026-09-21-edit-fuzzy-matching-and-read-state.md,
    // Track B) publishes no Service (plain plugin) and sits inside the group
    // IMMEDIATELY after post-edit-verify, with NO new isolate key.
    expect(configIds).toContain('edit-recovery-hint')
    expect(topIds).not.toContain('edit-recovery-hint')
    expect(configIds.indexOf('edit-recovery-hint')).toBe(configIds.indexOf('post-edit-verify') + 1)
    // The turn-rules row (plan docs/plans/2026-09-23-turn-rules.md) publishes
    // no Service (plain plugin) and sits inside the group directly after
    // edit-recovery-hint, with NO new isolate key. ORDER TRIPWIRE: it must
    // sort after the context-crusher row — CCR outermost, turn-rules composed
    // after it, so tool-result matching sees the post-crush text.
    expect(configIds).toContain('turn-rules')
    expect(topIds).not.toContain('turn-rules')
    expect(configIds.indexOf('turn-rules')).toBeGreaterThan(configIds.indexOf('context-crusher'))
    // The advisor-watchdog row (plan docs/plans/2026-09-23-advisor-watchdog.md)
    // publishes no Service (plain plugin) and sits inside the group at the
    // cc-services tail, after prompt-suggest, with NO new isolate key.
    // ORDER TRIPWIRE: it must sort after the turn-rules row — turn-rules'
    // prompt matcher must see the un-advised prompt.
    expect(configIds).toContain('advisor-watchdog')
    expect(topIds).not.toContain('advisor-watchdog')
    expect(configIds.indexOf('advisor-watchdog')).toBeGreaterThan(configIds.indexOf('turn-rules'))
    // The lsp-on-write row (plan docs/plans/2026-09-23-lsp-diagnostics-on-write.md)
    // publishes no Service (plain plugin) and sits inside the group directly
    // after edit-recovery-hint, with NO new isolate key. Its post-execute
    // listener is registered WITHOUT prepend so it composes inside the
    // context-crusher's outermost listener (same family as post-edit-verify).
    expect(configIds).toContain('lsp-on-write')
    expect(topIds).not.toContain('lsp-on-write')
    expect(configIds.indexOf('lsp-on-write')).toBe(configIds.indexOf('edit-recovery-hint') + 1)
    expect(configIds).toContain('command-plugin')
    expect(configIds).toContain('command-mcp')
    // The serena-first steering row consumes the isolated `mcpConnections`
    // realm and must sit inside the group, right after command-mcp (plan
    // docs/plans/2026-09-04-serena-first-prompt-sections.md).
    expect(configIds).toContain('serena-first')
    expect(topIds).not.toContain('serena-first')
    expect(configIds.indexOf('serena-first')).toBeGreaterThan(configIds.indexOf('command-mcp'))
    // The resume-pins plugin row publishes the `resumePinStore` service and
    // must sit inside the group, between cc-model-routes and tool-task (§4.10).
    expect(configIds.indexOf('cc-resume-pins')).toBeGreaterThan(configIds.indexOf('cc-model-routes'))
    expect(configIds.indexOf('cc-resume-pins')).toBeLessThan(configIds.indexOf('tool-task'))
    // The three commands live inside the group, not duplicated at top level.
    expect(topIds).not.toContain('command-plugin')
    expect(topIds).not.toContain('command-mcp')
    expect(configIds).toContain('command-doctor')
    expect(topIds).not.toContain('command-doctor')
    // memory + hooks-claude-code consume ctx.get('ccModelRoutes') and must
    // share the group realm; memory-consolidation stays outside (inherit).
    expect(configIds).toContain('memory')
    expect(configIds).toContain('hooks-claude-code')
    expect(configIds).toContain('tool-web-fetch')
    expect(topIds).not.toContain('memory')
    expect(topIds).not.toContain('hooks-claude-code')
    expect(topIds).not.toContain('tool-web-fetch')
    expect(topIds).toContain('memory-consolidation')

    // tool-web row: fetch is disabled here — web_fetch comes from the
    // cc-services tool-web-fetch row instead.
    const toolWeb = doc.find((r) => r.id === 'tool-web')!
    expect(toolWeb.config).toMatchObject({ fetch: false })
  })

  it('swaps the harness tool-workflow row for @dsh-cc/tool-workflow in the delegation group', () => {
    // (plan docs/plans/2026-09-22-workflow-cc-parity-core.md §3.1) Both tools
    // register the `workflow` tool name and the harness tools registry throws
    // "already registered" on duplicates, so the harness adapter row is
    // disabled and our @dsh-cc/tool-workflow row mounts in its place, between
    // the disabled harness row and tool-ralph. The tool publishes the
    // ccWorkflowRunRegistry preset service, so the group's isolate map must
    // carry it alongside workflowEngine (smoke:profile-boot refuses a preset
    // service outside an isolate realm — verified first-hand on this swap).
    const group = doc.find((r) => r.id === 'delegation')!
    expect(group.isolate).toEqual({ workflowEngine: true, ccWorkflowRunRegistry: true })
    const configIds = (group.config as any[]).map((r) => r.id)
    const harness = group.config.find((r: any) => r.id === 'tool-workflow')!
    expect(harness.name).toBe('@deepseek-ai/dsh-tool-workflow')
    expect(harness.disabled).toBe(true)
    const ours = group.config.find((r: any) => r.id === 'tool-workflow-cc')!
    expect(ours.name).toBe('@dsh-cc/tool-workflow')
    expect(ours.disabled).toBeUndefined()
    expect(configIds.indexOf('tool-workflow-cc'))
      .toBeGreaterThan(configIds.indexOf('tool-workflow'))
    expect(configIds.indexOf('tool-workflow-cc'))
      .toBeLessThan(configIds.indexOf('tool-ralph'))
    // The journal provider row mounts before the engine row; the engine's
    // provider flips from `spawn` to the wrapping journal provider (resume
    // slice: frozen-until-first-miss same-session replay). 0.1.7-rc.2: the
    // worker-thread engine package was deleted upstream; the preset row is
    // the sandboxed PTC engine (workflow-ptc).
    const journal = group.config.find((r: any) => r.id === 'subagent-workflow-journal')!
    expect(journal.name).toBe('@dsh-cc/workflow-journal')
    expect(journal.disabled).toBeUndefined()
    expect(configIds.indexOf('subagent-workflow-journal'))
      .toBeLessThan(configIds.indexOf('workflow-ptc'))
    const engine = group.config.find((r: any) => r.id === 'workflow-ptc')!
    expect(engine.name).toBe('@deepseek-ai/dsh-workflow-ptc')
    expect(engine.config).toMatchObject({ provider: 'cc-workflow-journal' })
  })

  it('declares every @dsh-cc row name as a dependency (top level and group-nested)', () => {
    const deps = Object.keys(pkgJson.dependencies ?? {})
    const rows: any[] = []
    for (const row of doc) {
      if (row.name === 'cordis:group' && Array.isArray(row.config)) {
        rows.push(...row.config)
      } else {
        rows.push(row)
      }
    }
    const dshCcRows = rows.filter((r) => r.name && r.name.startsWith('@dsh-cc/'))
    for (const row of dshCcRows) {
      expect(deps, `${row.id} -> ${row.name}`).toContain(row.name)
    }
  })

  it('every @dsh-cc row is installed by the release path: reachable via runtime deps from the launcher bundles, through publishable packages only', () => {
    // The launcher bootstraps a profile with `dsh plugin add` of the three
    // bundles; preset rows resolve from the profile's node_modules. A row that
    // no published package depends on resolves nowhere on a store install —
    // the exact defect that shipped from v0.5.0 through v0.7.0. This gate
    // walks the repo package graph exactly as publish would (workspace:^
    // converts 1:1 to semver) and fails the moment a row loses install
    // reachability.
    const repoRoot = join(dirname(agentCordisPath), '..', '..', '..')
    const manifest = new Map<string, { dependencies: Record<string, string>, peerDependencies: Record<string, string>, isPrivate: boolean }>()
    for (const group of readdirSync(join(repoRoot, 'packages'))) {
      const groupDir = join(join(repoRoot, 'packages'), group)
      if (!statSync(groupDir).isDirectory()) continue
      for (const pkg of readdirSync(groupDir)) {
        const pkgJsonPath = join(groupDir, pkg, 'package.json')
        if (!existsSync(pkgJsonPath)) continue
        const m = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        manifest.set(m.name, { dependencies: m.dependencies ?? {}, peerDependencies: m.peerDependencies ?? {}, isPrivate: m.private === true })
      }
    }

    const LAUNCHER_BUNDLES = ['@dsh-cc/bundle-permissions', '@dsh-cc/bundle-shell', '@dsh-cc/bundle-tui']
    // BFS over runtime dependencies from the bootstrap set.
    const reachable = new Set<string>()
    const queue = [...LAUNCHER_BUNDLES]
    while (queue.length > 0) {
      const name = queue.shift()!
      if (reachable.has(name)) continue
      const m = manifest.get(name)
      // Non-@dsh-cc / out-of-repo deps end the walk: they are upstream
      // packages the registry resolves on its own.
      if (m === undefined) continue
      reachable.add(name)
      for (const dep of Object.keys(m.dependencies)) {
        if (dep.startsWith('@dsh-cc/')) queue.push(dep)
      }
    }
    // Every package on the walked path must actually be published, or its
    // published dependents point at a package that does not exist.
    const privatePackages = [...reachable].filter((name) => manifest.get(name)!.isPrivate)
    expect(
      privatePackages,
      `reachable but private: ${privatePackages.join(', ')}`,
    ).toEqual([])

    const rows: any[] = []
    for (const row of doc) {
      if (row.name === 'cordis:group' && Array.isArray(row.config)) {
        rows.push(...row.config)
      } else {
        rows.push(row)
      }
    }
    const dshCcRows = rows.filter((r) => r.name && r.name.startsWith('@dsh-cc/'))
    expect(dshCcRows.length).toBeGreaterThan(0)
    for (const row of dshCcRows) {
      expect(
        reachable,
        `${row.id} -> ${row.name} is not installed by any package in the launcher bootstrap closure; `
        + 'add it to @dsh-cc/preset-cc dependencies and ensure @dsh-cc/tui depends on preset-cc',
      ).toContain(row.name)
    }

    // Peers must be provided by the closure too: an @dsh-cc peer is resolved
    // from the profile's node_modules like any bare import, and pnpm does not
    // auto-install it there — an uncovered peer is an ERR_MODULE_NOT_FOUND at
    // boot (@dsh-cc/hook-protocol shipped that way in 0.7.1-rc.2).
    const peerNames = new Set<string>()
    for (const name of reachable) {
      for (const peer of Object.keys(manifest.get(name)!.peerDependencies)) {
        if (peer.startsWith('@dsh-cc/')) peerNames.add(peer)
      }
    }
    for (const peer of peerNames) {
      expect(
        reachable,
        `${peer} is a peer of packages in the launcher bootstrap closure but nothing in the closure provides it; `
        + 'add it as a runtime dependency of the host-plane provider (bundle-shell)',
      ).toContain(peer)
    }
  })

  it('every @dsh-cc loader entry in the launcher bundles is a runtime dependency of its bundle', () => {
    // Loader entries mounted by a bundle's cordis.patch.yml are imported at
    // profile boot — they must be runtime deps of that bundle, not devDeps
    // (@dsh-cc/settings-migrations shipped this way and broke 0.7.1-rc.1's
    // first scratch boot: present in the yml, absent from node_modules).
    const repoRoot = join(dirname(agentCordisPath), '..', '..', '..')
    for (const group of readdirSync(join(repoRoot, 'packages', 'bundle'))) {
      const bundleDir = join(join(repoRoot, 'packages', 'bundle'), group)
      if (!statSync(bundleDir).isDirectory()) continue
      for (const file of readdirSync(bundleDir)) {
        if (!file.startsWith('cordis') || !file.endsWith('.yml')) continue
        const text = readFileSync(join(bundleDir, file), 'utf8')
        const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
        const deps = new Set(Object.keys(manifest.dependencies ?? {}))
        for (const match of text.matchAll(/name: '(@dsh-cc\/[a-z-]+)'/g)) {
          const name = match[1]!
          expect(
            deps,
            `${manifest.name}/${file} mounts ${name} but it is not a runtime dependency — a devDep loader entry is never installed on a store profile`,
          ).toContain(name)
        }
      }
    }
  })

  it('resolves every @deepseek-ai row name against an installed deployment', () => {
    const rows = doc.filter((r) => r.name && r.name.startsWith('@deepseek-ai/'))
    const seen = new Set<string>()
    const names: string[] = []
    for (const row of rows) {
      const name = row.name.startsWith('@deepseek-ai/dsh-tool-subagent-control')
        ? '@deepseek-ai/dsh-tool-subagent-control'
        : row.name
      if (seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }

    // Anchor to installed deployments (where @deepseek-ai/* actually lives at
    // runtime) — NOT the repo, which never installs upstream packages. Order:
    // profile install, then npx-cache installs (newest mtime first).
    const anchors: string[] = []
    const profileRoot = join(
      process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
      'profiles', 'node_modules', '@deepseek-ai',
    )
    if (existsSync(join(profileRoot, 'dsh', 'package.json'))) anchors.push(profileRoot)
    const npxRoot = join(process.env.HOME ?? '', '.npm', '_npx')
    const npxDirs = safeReaddir(npxRoot)
      .map((d) => join(npxRoot, d, 'node_modules', '@deepseek-ai'))
      .filter((d) => existsSync(join(d, 'dsh', 'package.json')))
    npxDirs.sort(
      (a, b) =>
        statSync(join(b, 'dsh', 'package.json')).mtimeMs -
        statSync(join(a, 'dsh', 'package.json')).mtimeMs,
    )
    anchors.push(...npxDirs)

    if (anchors.length === 0) {
      // No dsh install on this machine — nothing to resolve against.
      console.warn(
        '[composition] no dsh deployment found; skipping @deepseek-ai resolution check',
      )
      return
    }

    const missing: string[] = []
    for (const name of names) {
      const ok = anchors.some((a) => existsSync(join(a, name.slice('@deepseek-ai/'.length), 'package.json')))
      if (!ok) missing.push(name)
    }
    expect(
      missing,
      `@deepseek-ai rows missing from every installed deployment:\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it(
    'curated baseline matches the upstream standard preset (drift gate)',
    () => {
      // Both sides are canonicalized through load→dump and compared ROW BY
      // ROW (recursively through cordis:group configs): the upstream side is
      // now a nested patch row (indented under preset-standard's plugins),
      // the dsh-cc side is the flat agent.cordis.yml base slice, and raw
      // line-diffing would report indentation and comment noise instead of
      // real drift. Each divergent row id must appear in DRIFT_ALLOWANCE
      // with its reason — an unlisted divergence, or an upstream change to a
      // whitelisted row that cc has not deliberately mirrored, fails here.
      const upstreamPatch = yaml.load(readFileSync(anchor!.file, 'utf8'), { schema: entryListSchema })
      const standard = flattenInserts(upstreamPatch).find((r: any) => r.id === 'preset-standard')
      if (standard === undefined) {
        throw new Error(`no preset-standard declaration in ${anchor!.file}`)
      }
      const endToken = '# END dsh-cc header'
      const ccToken = '# ── cc rows ──'
      const start = yamlText.indexOf(endToken) + endToken.length + 1
      const end = yamlText.indexOf(ccToken)
      const mine = rowMap(yaml.load(yamlText.slice(start, end), { schema: entryListSchema }))
      const upstream = rowMap(standard.config.plugins)

      const diffs: { id: string; text: string }[] = []
      for (const id of new Set([...mine.keys(), ...upstream.keys()])) {
        const a = mine.get(id)
        const b = upstream.get(id)
        if (a === undefined) {
          diffs.push({ id, text: `upstream-only row ${id}:\n${canonical(b)}` })
        } else if (b === undefined) {
          diffs.push({ id, text: `cc-only row ${id}:\n${canonical(a)}` })
        } else if (canonical(a) !== canonical(b)) {
          diffs.push({ id, text: `row ${id} diverged:\n--- cc ---\n${canonical(a)}\n--- upstream ---\n${canonical(b)}` })
        }
      }
      const unexpected = diffs.filter(({ id }) => DRIFT_ALLOWANCE[id] === undefined)
      expect(
        unexpected.map(({ text }) => text),
        `baseline drifted from the upstream standard preset (${anchor!.source}); ` +
          `${unexpected.length} unlisted divergence(s) — fold in upstream changes or ` +
          `document the deliberate delta in DRIFT_ALLOWANCE`,
      ).toEqual([])
    },
  )
})

describe('cc declaration row (packages/bundle/cc-tui/cordis.patch.yml)', () => {
  // The declaration row IS the roster under the 0.1.7-rc.2 registry
  // architecture (G15): pin its identity, its carried composition (by
  // reference — the file-backed include row), and its metadata against
  // preset.yml so the two never drift.
  const patch = yaml.load(
    readFileSync(new URL('../../../bundle/cc-tui/cordis.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema },
  ) as any[]

  it('declares cc with the include-carried composition and preset.yml metadata', () => {
    const rows = flattenInserts(patch)
    const registry = rows.find((r) => r.id === 'agent-preset-registry')
    expect(registry?.name).toBe('@deepseek-ai/dsh-agent-preset-registry')
    expect(registry?.config?.default).toBe('cc')
    const row = rows.find((r) => r.id === 'preset-cc')
    expect(row?.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(row?.config?.id).toBe('cc')
    const preset = yaml.load(readFileSync(presetYmlPath, 'utf8'), { schema: entryListSchema }) as any
    expect(row?.config?.name).toBe(preset.name)
    expect(row?.config?.description).toBe(preset.description)
    expect(row?.config?.order).toBe(preset.order)
    // Composition by reference: profile node_modules is the resolution base
    // of the declaring loader, and @dsh-cc/preset-cc ships agent.cordis.yml.
    expect(row?.config?.plugins).toEqual([
      {
        id: 'cc-composition',
        name: '@deepseek-ai/cordis-plugin-include',
        config: { path: 'node_modules/@dsh-cc/preset-cc/agent.cordis.yml' },
      },
    ])
  })
})

describe('version comparison (drift-gate floor binding)', () => {
  it('orders rc releases numerically, not lexicographically', () => {
    expect(cmpVersion('0.1.0-rc.10', '0.1.0-rc.2')).toBeGreaterThan(0)
  })

  it('ranks a newer upstream release above an older one', () => {
    expect(cmpVersion('0.1.1-rc.2', '0.1.0-rc.8')).toBeGreaterThan(0)
  })

  it('rejects malformed versions as unsatisfying any floor', () => {
    expect(cmpVersion('0.1.0', '0.1.0-rc.2')).toBeLessThan(0)
    expect(cmpVersion('garbage', '0.1.0-rc.2')).toBeLessThan(0)
    expect(cmpVersion(undefined, '0.1.0-rc.2')).toBeLessThan(0)
  })
})

/** Flatten nested `insert` patch lists into one row list (document order). */
function flattenInserts(rows: unknown): any[] {
  const out: any[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    out.push(row)
    if (Array.isArray((row as any)?.insert)) out.push(...flattenInserts((row as any).insert))
  }
  return out
}

/**
 * Deliberate divergences of the cc baseline from the upstream standard
 * preset, keyed by row id. Anything not listed must match upstream exactly.
 */
const DRIFT_ALLOWANCE: Record<string, string> = {
  // Upstream carries the working-directory clause as a separate `suffix`;
  // cc folds both clauses into one `prefix` (same rendered text).
  persona: 'suffix folded into prefix',
  // The /goal command stays host-plane in cc (the tool row is mounted here).
  'command-goal': 'host-plane row, not part of the agent composition',
  // Upstream-only surfaces cc does not ship.
  present: 'upstream-only surface',
  'tool-plugin-manager': 'upstream-only (disabled) surface',
  // Deliberate name swaps, ids unchanged: the CC engine subclass folds a
  // /compact hint into the summarizer; the CC command forwards the argument.
  compaction: '@dsh-cc/compaction-basic + @dsh-cc/command-compact replace the upstream rows',
  // CC workflow surface: the journal provider + @dsh-cc/tool-workflow replace
  // workflow-ptc; the harness tool-workflow adapter stays disabled (duplicate
  // `workflow` registration) and tool-ralph stays enabled; the harness
  // subagent tools stay disabled (replaced by cc-services `tool-task`).
  delegation: 'journal + @dsh-cc/tool-workflow swap, tool-ralph enabled, subagent tools disabled',
  // fetch: false — cc-services tool-web-fetch owns the model-facing tool.
  'tool-web': 'fetch disabled, searchTimeoutMs carried forward',
}

/** Index rows by id. Group rows are kept atomic: their canonical form
 * includes the nested children, so one allowance entry covers a whole
 * deliberately-diverged group. */
function rowMap(rows: unknown): Map<string, any> {
  const map = new Map<string, any>()
  for (const row of flattenInserts(rows)) {
    if (!map.has(row.id)) map.set(row.id, row)
  }
  return map
}

/** Canonical YAML rendering: one shape for both sides of the drift diff. */
function canonical(value: unknown): string {
  return yaml.dump(value, { schema: entryListSchema, lineWidth: -1 }).trimEnd()
}

describe('preset.yml metadata', () => {
  it('has non-empty name/description and order 5', () => {
    const preset = yaml.load(readFileSync(presetYmlPath, 'utf8'), {
      schema: entryListSchema,
    }) as any
    expect(typeof preset.name).toBe('string')
    expect(preset.name.trim().length).toBeGreaterThan(0)
    expect(typeof preset.description).toBe('string')
    expect(preset.description.trim().length).toBeGreaterThan(0)
    expect(typeof preset.order).toBe('number')
    expect(Number.isFinite(preset.order)).toBe(true)
    expect(preset.order).toBe(5)
  })
})

describe('tracked hooks.json (serena code-intelligence plan, Phase 0)', () => {
  const hooksJsonPath = new URL('../../../../hooks.json', import.meta.url).pathname

  it('wires the hooks-claude-code row to the tracked hooks.json', () => {
    const rows: any[] = []
    for (const row of doc) {
      if (row.name === 'cordis:group' && Array.isArray(row.config)) rows.push(...row.config)
      else rows.push(row)
    }
    const hooksRow = rows.find((r) => r.id === 'hooks-claude-code')
    expect(hooksRow).toBeDefined()
    // Relative configPath resolves against the process launch cwd — the
    // worktree root when `dsh cc-tui` starts there — so a tracked root-level
    // file loads in worktree sessions by construction (plan fact 5).
    expect(hooksRow.config).toMatchObject({ configPath: 'hooks.json' })
    expect(existsSync(hooksJsonPath)).toBe(true)
  })

  it('hooks.json parses and every matcher either is a literal token set or compiles as a regex', () => {
    // A malformed matcher regex rejects the ENTIRE hooks config warn-only
    // (plan fact 7), so every matcher must be validated here.
    const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'))
    expect(parsed).toBeTypeOf('object')
    expect(parsed.hooks).toBeTypeOf('object')
    for (const [event, entries] of Object.entries(parsed.hooks) as [string, any[]][]) {
      expect(Array.isArray(entries), `${event} entries`).toBe(true)
      for (const entry of entries) {
        expect(Array.isArray(entry.hooks), `${event} entry hooks`).toBe(true)
        if (typeof entry.matcher !== 'string') continue
        if (/^[A-Za-z0-9_|]+$/.test(entry.matcher)) continue // literal-token dialect
        expect(() => new RegExp(entry.matcher), `matcher ${entry.matcher}`).not.toThrow()
        expect(entry.matcher.startsWith('^'), `matcher ${entry.matcher} must be anchored (unanchored regexes substring-match)`).toBe(true)
      }
    }
  })
})
