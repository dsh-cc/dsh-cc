/**
 * `hooks` checks for `/doctor`: the hook bridge load report, flag defaults,
 * and the verbose-only `serena-hooks` PATH probe.
 * @module @dsh-cc/command-doctor/checks/hooks
 */

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'

/** Duck-typed `hookBridgeStatus` face used here. */
export interface HookBridgeStatus {
  readonly sourcePath: string
  readonly events: readonly { name: string; groups: number; hooks: number }[]
  readonly skipped: readonly { event?: string; type?: string; reason?: string }[]
  /** Loaded command-hook strings (after substitution); doctor scans these for binaries. */
  readonly commands?: readonly string[]
  readonly error?: string
  readonly enablePromptHooks: boolean
  readonly enableAgentHooks: boolean
}

/** Collect the hooks group checks. */
export function hookChecks(ctx: Context, options: { verbose: boolean }): Check[] {
  const status = ctx.get('hookBridgeStatus') as HookBridgeStatus | undefined
  const checks: Check[] = []
  if (status === undefined) {
    checks.push({
      id: 'hooks.bridge',
      group: 'hooks',
      status: 'skip',
      summary: 'hookBridgeStatus seam not mounted',
    })
    checks.push(discoveryCheck())
    return checks
  }
  checks.push(status.error === undefined
    ? {
        id: 'hooks.source',
        group: 'hooks',
        status: 'ok',
        summary: status.sourcePath,
        evidence: { sourcePath: status.sourcePath },
      }
    : {
        id: 'hooks.source',
        group: 'hooks',
        status: 'fail',
        summary: String(status.error),
        detail: `no hooks are registered (${status.sourcePath})`,
        fix: 'fix the hook configuration so it parses',
        evidence: { sourcePath: status.sourcePath },
      })
  checks.push(status.events.length === 0
    ? { id: 'hooks.events', group: 'hooks', status: 'info', summary: 'no hook events registered' }
    : {
        id: 'hooks.events',
        group: 'hooks',
        status: 'ok',
        summary: status.events.map(event => `${event.name}: ${event.groups}/${event.hooks}`).join(', '),
        evidence: { events: status.events.length },
      })
  checks.push(status.skipped.length === 0
    ? { id: 'hooks.skipped', group: 'hooks', status: 'ok', summary: 'none' }
    : {
        id: 'hooks.skipped',
        group: 'hooks',
        status: 'warn',
        summary: `${status.skipped.length} skipped hook entries`,
        detail: status.skipped
          .map(skip => `${skip.event ?? '?'}: ${skip.type ?? '?'} — ${skip.reason ?? 'malformed'}`)
          .join('; '),
        evidence: { skipped: status.skipped.length },
      })
  checks.push(status.enablePromptHooks === false && status.enableAgentHooks === false
    ? {
        id: 'hooks.prompt-agent',
        group: 'hooks',
        status: 'info',
        summary: 'prompt/agent hooks are disabled (expected default-off)',
      }
    : {
        id: 'hooks.prompt-agent',
        group: 'hooks',
        status: 'ok',
        summary: `prompt hooks ${status.enablePromptHooks ? 'on' : 'off'}, agent hooks ${status.enableAgentHooks ? 'on' : 'off'}`,
      })
  checks.push(serenaHooksCheck(status, options.verbose))
  checks.push(discoveryCheck())
  return checks
}

/** The always-present info note on unimplemented CC discovery semantics. */
function discoveryCheck(): Check {
  return {
    id: 'hooks.discovery',
    group: 'hooks',
    status: 'info',
    summary: 'CC layered project/user discovery and live reload are not implemented',
  }
}

/**
 * `serena-hooks` availability. Default: report "not probed (use --verbose)"
 * when referenced, skip when not referenced. Verbose: a pure-fs PATH scan
 * (no `which`).
 */
function serenaHooksCheck(status: HookBridgeStatus, verbose: boolean): Check {
  const referenced = (status.commands ?? []).some(command => command.includes('serena-hooks'))
  if (!referenced) {
    return { id: 'hooks.serena-hooks', group: 'hooks', status: 'skip', summary: 'not referenced' }
  }
  if (!verbose) {
    return { id: 'hooks.serena-hooks', group: 'hooks', status: 'info', summary: 'not probed (use --verbose)' }
  }
  const found = scanPath('serena-hooks')
  return found === undefined
    ? {
        id: 'hooks.serena-hooks',
        group: 'hooks',
        status: 'fail',
        summary: 'serena-hooks is referenced by a loaded hook but not on PATH',
        fix: 'install serena-hooks or extend PATH',
      }
    : {
        id: 'hooks.serena-hooks',
        group: 'hooks',
        status: 'ok',
        summary: `found at ${found}`,
        evidence: { path: found },
      }
}

/** Pure-fs PATH scan; appends platform executable suffixes. */
export function scanPath(binary: string): string | undefined {
  const path = process.env.PATH ?? ''
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, `${binary}${suffix}`)
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return candidate
        } catch {
          // Vanished between existsSync and stat; keep scanning.
        }
      }
    }
  }
  return undefined
}
