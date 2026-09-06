/**
 * Side-effect-free path resolution and file-reading for MCP config discovery.
 *
 * `resolveDefaultMcpPaths` classifies the default `.mcp.json` locations into
 * dsh-native, Claude Code, and migration-target buckets as a pure function of
 * injectable `{ env, cwd, home }`. `readMcpServerNames` reads a single config
 * file without ever throwing, and `claudeOnlyServers` reports the Claude Code
 * server names not shadowed by a dsh-native file. Nothing in this module
 * writes to disk; the package's only file-WRITING surface is `migrate.ts`.
 *
 * @module @dsh-cc/mcp-config/paths
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseMcpServers } from './index.ts'

/** The default MCP config locations, classified by origin. */
export interface ResolvedMcpPaths {
  /** dsh-native config files in discovery order (`<cwd>/.mcp.json`, `$DSH_HOME/.mcp.json`). */
  dsh: string[]
  /** Claude Code config files in discovery order (`<claudeDir>/.mcp.json`, `<home>/.claude.json`). */
  claude: string[]
  /** The migration target: `$DSH_HOME/.mcp.json` (default `~/.dsh/.mcp.json`). */
  target: string
}

/** Injectable process inputs for {@link resolveDefaultMcpPaths}; defaults read `process`/`os`. */
export interface McpPathInputs {
  /** Environment lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Working directory anchoring the project `.mcp.json`; defaults to `process.cwd()`. */
  cwd?: string
  /** User home directory; defaults to `os.homedir()`. */
  home?: string
}

/**
 * Classify the default MCP config paths. `claudeDir` honors
 * `CLAUDE_CONFIG_DIR` exactly as Claude Code does, while the `~/.claude.json`
 * state file stays anchored at the user home regardless of the config dir.
 *
 * @param inputs - injectable `{ env, cwd, home }`; pure when all are provided.
 * @returns the dsh-native, Claude Code, and migration-target paths.
 */
export function resolveDefaultMcpPaths(inputs: McpPathInputs = {}): ResolvedMcpPaths {
  const env = inputs.env ?? process.env
  const cwd = inputs.cwd ?? process.cwd()
  const home = inputs.home ?? homedir()
  const dshHome = env.DSH_HOME ? resolve(env.DSH_HOME) : join(home, '.dsh')
  const claudeDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude')
  const projectFile = join(resolve(cwd), '.mcp.json')
  const dshFile = join(dshHome, '.mcp.json')
  return {
    dsh: [projectFile, dshFile],
    claude: [join(claudeDir, '.mcp.json'), join(home, '.claude.json')],
    target: dshFile,
  }
}

/**
 * The declared server names of one config file, without ever throwing.
 * Names are the raw `mcpServers` keys in file order — never env-expanded or
 * tool-name normalized.
 */
export type McpServerNames =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; names: string[] }

/**
 * Read the server names declared by one `.mcp.json` file.
 *
 * @param path - config file to read.
 * @returns `absent` when the file does not exist, `invalid` with the error
 * message when it is unreadable/unparseable/fails `mcpServers` validation,
 * else `ok` with the raw declared names in order.
 */
export function readMcpServerNames(path: string): McpServerNames {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'invalid', error: (error as Error).message }
  }
  try {
    return { kind: 'ok', names: Object.keys(parseMcpServers(JSON.parse(raw))) }
  } catch (error) {
    return { kind: 'invalid', error: (error as Error).message }
  }
}

/** One Claude Code file's server names that no readable dsh file declares. */
export interface ClaudeOnlySource {
  /** The Claude Code config file the names were read from. */
  path: string
  /** Declared names not shadowed by any dsh-native file. */
  names: string[]
}

/**
 * Report, per Claude Code file, the server names that no dsh-native file
 * declares — the servers a gating discovery would silently skip. Invalid or
 * absent files on either side are skipped.
 *
 * @param paths - the dsh-native and Claude Code file paths.
 * @returns one entry per Claude Code file that still declares unshadowed names.
 */
export function claudeOnlyServers(paths: Pick<ResolvedMcpPaths, 'dsh' | 'claude'>): ClaudeOnlySource[] {
  const dshNames = new Set<string>()
  for (const file of paths.dsh) {
    const names = readMcpServerNames(file)
    if (names.kind === 'ok') for (const name of names.names) dshNames.add(name)
  }
  const result: ClaudeOnlySource[] = []
  for (const file of paths.claude) {
    const names = readMcpServerNames(file)
    if (names.kind !== 'ok') continue
    const only = names.names.filter(name => !dshNames.has(name))
    if (only.length > 0) result.push({ path: file, names: only })
  }
  return result
}
