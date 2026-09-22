#!/usr/bin/env node
/**
 * Shared gating for the serena code-intelligence hooks shipped by this
 * plugin (docs/plans/2026-09-22-serena-hooks-agents-plugin.md).
 *
 * dsh-cc-agents is enabled profile-wide, but the serena remind/cleanup hooks
 * only make sense where serena is actually adopted. `runGatedSerenaHook`
 * enforces that with two silent gates, so on non-serena projects each hook
 * invocation costs one node spawn and nothing else:
 *
 *   1. Project gate — walk ancestors from the session project dir until a
 *      directory containing `.serena/project.yml` (serena's onboarding
 *      artifact) is found. The walk is inclusive of the git toplevel (`.git`
 *      file or directory) and stops at it, the filesystem root, or `$HOME`.
 *      Sessions launched in subdirectories still resolve the project root.
 *   2. Binary gate — `serena-hooks` must resolve on `PATH` (plain fs scan;
 *      no `which` dependency).
 *
 * Both gates pass → spawn `serena-hooks <subcommand> --client claude-code`,
 * piping the hook payload through stdin and extending the env with
 * `SERENA_HOME=<projectRoot>/.serena` (the session sandbox's writable
 * surface; serena's `~/.serena` default is outside it and its `save()`
 * swallows the failure — the dead-counter incident fixed by PR #100). The
 * child's stdout is relayed verbatim so the CC `hookSpecificOutput` response
 * reaches the bridge unchanged.
 *
 * Exit-0 discipline (watchdog-script precedent): every failure path —
 * unreadable stdin, no serena project, missing binary, spawn error, child
 * timeout — exits 0 with no output. A hook must never break a tool call.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, delimiter, join, resolve } from 'node:path'

/** Read the whole hook payload from stdin; empty/unparseable → undefined. */
function readPayload() {
  let raw
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? { raw, parsed } : undefined
  } catch {
    return undefined
  }
}

function hasSerenaProject(dir) {
  return existsSync(join(dir, '.serena', 'project.yml'))
}

/** Walk ancestors for the serena project root; stop at git toplevel (incl.), fs root, $HOME. */
export function findSerenaProjectRoot(startDir) {
  const home = resolve(homedir())
  let dir = resolve(startDir)
  for (;;) {
    if (hasSerenaProject(dir)) return dir
    if (dir === home) return undefined
    if (existsSync(join(dir, '.git'))) return undefined // toplevel reached, no serena there
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** True when `bin` resolves on PATH (fs scan; win32 gets its suffix variants). */
export function resolvesOnPath(bin) {
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue
    for (const suffix of suffixes) {
      if (existsSync(join(entry, bin + suffix))) return true
    }
  }
  return false
}

/** Child lifetime cap stays below the hooks.json timeout (10s) with node-boot margin. */
const SPAWN_TIMEOUT_MS = 8000

/**
 * Gate-and-run `serena-hooks <subcommand> --client claude-code`. Always
 * resolves; never throws; process exits 0 regardless of outcome.
 * @param {'remind' | 'cleanup'} subcommand
 */
export function runGatedSerenaHook(subcommand) {
  try {
    const payload = readPayload()
    const projectDir =
      process.env.CLAUDE_PROJECT_DIR ??
      (typeof payload?.parsed.cwd === 'string' ? payload.parsed.cwd : undefined) ??
      process.cwd()
    const projectRoot = findSerenaProjectRoot(projectDir)
    if (projectRoot === undefined) return
    if (!resolvesOnPath('serena-hooks')) return
    const res = spawnSync('serena-hooks', [subcommand, '--client', 'claude-code'], {
      input: payload?.raw ?? '',
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, SERENA_HOME: join(projectRoot, '.serena') },
    })
    if (res.error !== undefined && res.error !== null) return
    if (typeof res.stdout === 'string' && res.stdout !== '') process.stdout.write(res.stdout)
  } catch {
    // Exit-0 discipline: swallow everything.
  }
}
