/**
 * Human-facing `/auto-mode` command: introspection for the `auto`-mode
 * classifier configuration. `/auto-mode defaults` prints the built-in slot
 * lists (`$defaults`-expanded built-ins only); `/auto-mode config` prints the
 * effective `permissions.autoMode` slice as the permission-rules engine sees
 * it — trusted-scoped (D12: the cascade assembles this key from trusted
 * layers only), with each slot list `$defaults`-expanded and the classifier
 * sub-config resolved.
 *
 * All text derived from session/settings data passes through the shared
 * control-character sanitizer (`./sanitize.ts`); the S5 `review` subcommand
 * reuses it. No model call, no session write.
 * @module @dsh-cc/command-auto-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  DEFAULT_ALLOW_EXCEPTIONS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_SOFT_DENY,
  expandSlot,
} from '@dsh-cc/permission-rules'
import { helpable } from '@dsh-cc/command-usage'
import { sanitize } from './sanitize.ts'

export { sanitize } from './sanitize.ts'

export const name = 'command-auto-mode'
export const inject = ['commands']

/** The merged `permissions.autoMode` section as consumers resolve it. */
interface AutoModeSection {
  soft_deny?: string[]
  allow?: string[]
  environment?: string[]
  classifyAllShell?: boolean
  classifier?: {
    enabled?: boolean
    route?: string
    timeoutMs?: number
    cacheMaxEntries?: number
  }
}

/** Structural face of the settings provider: resolved (merged) section read. */
type SettingsLike = { get(ns: string): unknown }

/** The `$defaults`-expanded view of one slot list. */
function slotView(configured: readonly string[] | undefined, defaults: readonly string[]): Record<string, unknown> {
  return {
    configured: configured ?? null,
    expanded: expandSlot(configured ?? ['$defaults'], defaults),
  }
}

/** `/auto-mode defaults` — the built-in slot lists, `$defaults`-expanded. */
export function renderDefaults(): string {
  return sanitize(JSON.stringify({
    soft_deny: DEFAULT_SOFT_DENY,
    allow: DEFAULT_ALLOW_EXCEPTIONS,
    environment: DEFAULT_ENVIRONMENT,
  }, null, 2))
}

/** `/auto-mode config` — the effective trusted-scoped autoMode slice. */
export function renderConfig(autoMode: AutoModeSection | undefined): string {
  const classifier = autoMode?.classifier
  const payload = {
    classifier: {
      enabled: classifier?.enabled === true,
      route: classifier?.route ?? 'haiku',
      timeoutMs: classifier?.timeoutMs ?? 8000,
      cacheMaxEntries: classifier?.cacheMaxEntries ?? 256,
    },
    classifyAllShell: autoMode?.classifyAllShell === true,
    slots: {
      soft_deny: slotView(autoMode?.soft_deny, DEFAULT_SOFT_DENY),
      allow: slotView(autoMode?.allow, DEFAULT_ALLOW_EXCEPTIONS),
      environment: slotView(autoMode?.environment, DEFAULT_ENVIRONMENT),
    },
  }
  return sanitize(JSON.stringify(payload, null, 2))
}

function executeAutoMode(settings: SettingsLike | undefined, invocation: CommandInvocation): CommandResult {
  const subcommand = invocation.rawInput.trim().split(/\s+/)[0] ?? ''
  if (subcommand === 'defaults') {
    return { kind: 'success', text: renderDefaults() }
  }
  if (subcommand === 'config') {
    if (settings === undefined) {
      return { kind: 'error', text: 'No settings provider is mounted in this composition.' }
    }
    const permissions = settings.get('permissions') as { autoMode?: AutoModeSection } | undefined
    return { kind: 'success', text: renderConfig(permissions?.autoMode) }
  }
  return {
    kind: 'error',
    text: 'unknown subcommand; usage: /auto-mode defaults | /auto-mode config',
  }
}

/**
 * Register `/auto-mode`. The permission engine's view of the autoMode slice is
 * the merged settings section (`installSectionSafe` reads the same published
 * document), so the command reads it through the settings provider directly.
 * @param ctx - context carrying the command registry and settings provider.
 */
export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsLike | undefined
  ctx.commands.register(helpable({
    name: 'auto-mode',
    description: 'show auto-mode classifier defaults or the effective trusted-scoped configuration',
    input: { hint: '[defaults|config]' },
    handler: (invocation: CommandInvocation) => executeAutoMode(settings, invocation),
  }, {
    subcommands: [
      { word: 'defaults', summary: 'print the built-in slot lists ($defaults-expanded)' },
      { word: 'config', summary: 'print the effective autoMode slice (trusted-scoped, expanded)' },
    ],
  }))
}
