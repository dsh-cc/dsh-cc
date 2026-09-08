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

// The standard-preset anchor for the drift gate. We align with whichever
// upstream is CURRENTLY linked/installed rather than pinning a version, so the
// gate tracks the real upstream instead of silently skipping.
interface AnchorPreset {
  /** Absolute path to the `config/agent-presets/standard/agent.cordis.yml` file. */
  file: string
  /** Human-readable origin, used in gate failure messages. */
  source: string
}

// tier-1: the linked upstream checkout. `@deepseek-ai/cordis-plugin-include` is
// symlinked (via node_modules) into the deepseek-harness repo's vendor/include/,
// so walking up from its package.json — never a relative path, which breaks in
// a worktree layout — finds the standard preset in that checkout.
function resolveLinkedAnchor(): AnchorPreset | undefined {
  try {
    const real = realpathSync(includePkg)
    let cur = dirname(real)
    for (let i = 0; i < 4; i++) {
      const cand = join(cur, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
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
        const file = join(dirname(p), 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
        // A qualifying install whose layout lacks the preset file (or a future
        // rename) must fall through to the next candidate, not turn the
        // should-skip case into a readFileSync failure inside the test.
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
  console.warn('[composition] drift gate: no anchor preset found (tier-1 link, tier-2 install); gate skipped')
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

  it('isolates exactly the seven cc-services services, hosting the commands and the ccModelRoutes consumers', () => {
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
    })
    const configIds = (group.config as any[]).map((r) => r.id)
    const topIds = doc.map((r) => r.id)
    expect(configIds).toContain('command-plugin')
    expect(configIds).toContain('command-mcp')
    // The serena-first steering row consumes the isolated `mcpConnections`
    // realm and must sit inside the group, right after command-mcp (plan
    // docs/plans/2026-09-16-serena-first-prompt-sections.md).
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

  it.runIf(!!anchor)(
    'curated baseline matches the vendored standard preset (drift gate)',
    () => {
      const vendoredBase = readFileSync(anchor!.file, 'utf8')
      const endToken = '# END dsh-cc header'
      const ccToken = '# ── cc rows ──'
      const start = yamlText.indexOf(endToken) + endToken.length + 1
      const end = yamlText.indexOf(ccToken)
      const myBase = yamlText.slice(start, end).trimEnd()

      const a = myBase.split('\n')
      const b = vendoredBase.trimEnd().split('\n')
      // LCS diff so inserted comment lines (above tool-web) are reported as
      // additions instead of shifting every later line out of alignment.
      const ops = lcsOps(a, b)
      const diffs: string[] = []
      for (const op of ops) {
        if (op.type === 'equal') continue
        const mine = op.a === -1 ? '' : a[op.a]
        const vend = op.b === -1 ? '' : b[op.b]
        // Whitelist: the tool-web config change (fetch/searchTimeoutMs lines,
        // any shape), comment-only lines added to document that change, and
        // the `disabled: true` additions on the harness subagent tool rows
        // (tool-subagent / tool-subagent-fork), whose Task is replaced by the
        // cc-services `tool-task` row. Only my-side additions are whitelisted —
        // an upstream `disabled: true` we drop would still be flagged.
        const isConfigChange =
          (op.a !== -1 && a[op.a].includes('fetch:')) ||
          (op.a !== -1 && a[op.a].includes('searchTimeoutMs:')) ||
          (op.b !== -1 && b[op.b].includes('fetch:')) ||
          (op.b !== -1 && b[op.b].includes('searchTimeoutMs:')) ||
          (op.a !== -1 && a[op.a].trim() === 'disabled: true')
        const isComment = mine.trimStart().startsWith('#') || vend.trimStart().startsWith('#')
        // Whitelist: the two deliberate name swaps in the compaction group
        // (row ids stay identical). The CC engine subclass folds /compact
        // hints into the summarizer; the CC command forwards the free-text
        // argument instead of rejecting it. Matched both directions so the
        // LCS may report the swap as one del/add pair or two one-sided ops.
        const isNameSwap =
          ((mine.includes("name: '@dsh-cc/compaction-basic'")
            && (vend === '' || vend.includes("name: '@deepseek-ai/dsh-compaction-basic'")))
          || (mine.includes("name: '@dsh-cc/command-compact'")
            && (vend === '' || vend.includes("name: '@deepseek-ai/dsh-command-compact'")))
          || (vend.includes("name: '@deepseek-ai/dsh-compaction-basic'")
            && (mine === '' || mine.includes("name: '@dsh-cc/compaction-basic'")))
          || (vend.includes("name: '@deepseek-ai/dsh-command-compact'")
            && (mine === '' || mine.includes("name: '@dsh-cc/command-compact'"))))
        if (isConfigChange || isComment || isNameSwap) continue
        diffs.push(
          `${op.type === 'add' ? '+' : '-'}  mine: ${mine}\n` +
            `${op.type === 'del' ? '-' : '+'}  vendored: ${vend}`,
        )
      }
      expect(
        diffs,
        `baseline drifted from the vendored standard preset (${anchor!.source}); ` +
          `${diffs.length} diff line(s) outside the whitelist`,
      ).toEqual([])
    },
  )
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

/** Minimal LCS line-diff. Yields add/del/equal ops against both inputs. */
function lcsOps(a: string[], b: string[]): { type: 'add' | 'del' | 'equal'; a: number; b: number }[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: { type: 'add' | 'del' | 'equal'; a: number; b: number }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: 'equal', a: i, b: j })
      i++
      j++
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'add', a: -1, b: j })
      j++
    } else {
      ops.push({ type: 'del', a: i, b: -1 })
      i++
    }
  }
  return ops
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
