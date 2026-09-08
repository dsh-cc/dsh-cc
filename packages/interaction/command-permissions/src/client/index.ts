/**
 * Browser half of `@dsh-cc/command-permissions`. Hangs a popupSelect
 * DECORATION on the host `/permissions` command. The decoration owns only the
 * bare invocation; the host command keeps its catalog row, the argued path
 * (`/permissions <mode>` still switches directly), and the lifecycle logging.
 * A pick submits `/permissions ${id}` so both surfaces write through one path.
 *
 * `/permission` (host, sandbox+approval presets) is hidden from the CC
 * slash catalog by the host half wrapping `commands.list`; this decoration
 * only covers `/permissions`. The composer chip still executes
 * `/permission <preset>` against the global handler.
 *
 * @module @dsh-cc/command-permissions/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { BYPASS_CONFIRMATION, BYPASS_MODE, PERMISSION_MODE_OPTIONS } from '../modes.ts'

export const inject = ['commandUi', 'sessions']

/**
 * Resolve the live session face for a popup session scope (undefined = not
 * materialized). `ctx.sessions` reads the client sessions face; some shared
 * node packages over-declare the same key as their own store, so narrow it to
 * the client contract here.
 */
function sessionFor(ctx: ClientContext, session: ClientSessionContext): SessionFace | undefined {
  const sessions = ctx.sessions as unknown as ISessions
  return sessions.binding(session.sessionId)?.session
}

/** Flatten the shareable mode rows into popup options; bypassPermissions carries the risk gate. */
function optionsOf(): SelectOption[] {
  return PERMISSION_MODE_OPTIONS.map(option => ({
    id: option.id,
    label: option.label,
    detail: option.detail,
    ...(option.id === BYPASS_MODE ? { confirmation: { ...BYPASS_CONFIRMATION } } : {}),
  }))
}

/**
 * Register the `/permissions` bare-invocation popup over the host command.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  ctx.effect(() => command.decorate({
    name: 'permissions',
    // The host catalog already hides `/permissions` from non-CC sessions
    // (`commands.list` wrap). A missing host row means this decoration is a
    // no-op — it never manufactures a command.
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: () => Promise.resolve(optionsOf()),
      onSelect: async (option, session) => {
        const live = sessionFor(ctx, session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permissions ${option.id}`)
        if (!result.ok) throw new Error(`permission mode switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permissions command')
      },
    },
  }), 'command-permissions: /permissions decoration')
}
