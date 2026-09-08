/**
 * `session` checks for `/doctor`: identity, cwd, presets, and the dsh profile.
 * @module @dsh-cc/command-doctor/checks/session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Check } from '../report.ts'

/** Collect the session group checks. */
export function sessionChecks(ctx: Context, invocation: CommandInvocation): Check[] {
  const checks: Check[] = []
  const session = invocation.agent.session
  checks.push({
    id: 'session.id',
    group: 'session',
    status: 'ok',
    summary: session.id,
    evidence: { sessionId: session.id },
  })
  const cwd = session.header.cwd ?? process.cwd()
  checks.push({
    id: 'session.cwd',
    group: 'session',
    status: 'ok',
    summary: cwd,
    evidence: { cwd },
  })
  checks.push(permissionPresetCheck(ctx, session.snapshotEvents()))
  checks.push(agentPresetCheck(ctx))
  checks.push(dshProfileCheck(ctx))
  return checks
}

/** Fold the effective permission preset; throw or missing → skip. */
function permissionPresetCheck(
  ctx: Context,
  events: readonly unknown[],
): Check {
  const presets = ctx.get('permissionPresets') as
    | { current(events: readonly unknown[]): string }
    | undefined
  if (presets === undefined) {
    return { id: 'session.permission-preset', group: 'session', status: 'skip', summary: 'permissionPresets seam not mounted' }
  }
  try {
    const preset = presets.current(events)
    return {
      id: 'session.permission-preset',
      group: 'session',
      status: 'ok',
      summary: preset,
      evidence: { preset },
    }
  } catch (error) {
    return {
      id: 'session.permission-preset',
      group: 'session',
      status: 'skip',
      summary: `preset unavailable: ${String(error)}`,
    }
  }
}

/** Fold the default agent preset id; missing → skip. */
function agentPresetCheck(ctx: Context): Check {
  const presets = ctx.get('agentPresets') as { defaultId?: unknown } | undefined
  const defaultId = typeof presets?.defaultId === 'string' ? presets.defaultId : undefined
  if (defaultId === undefined) {
    return { id: 'session.agent-preset', group: 'session', status: 'skip', summary: 'agentPresets seam not mounted' }
  }
  return {
    id: 'session.agent-preset',
    group: 'session',
    status: 'ok',
    summary: defaultId,
    evidence: { defaultId },
  }
}

/** Fold the dsh profile (`'tui'`); missing → skip. */
function dshProfileCheck(ctx: Context): Check {
  const profile = ctx.get('dshProfile')
  if (typeof profile !== 'string' || profile.length === 0) {
    return {
      id: 'session.dsh-profile',
      group: 'session',
      status: 'skip',
      summary: 'dshProfile seam not mounted',
    }
  }
  return {
    id: 'session.dsh-profile',
    group: 'session',
    status: 'ok',
    summary: profile,
    evidence: { profile },
  }
}
