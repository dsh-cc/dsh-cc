/** Atomic continuation admission after approval, held until delivery settles. */
import { admitContinuation, type CapacityServices } from './live-capacity.ts'

/** No per-execution tracker: every acquired lease has a lexical finally. */
export function wireDispatchAdmission(ctx: unknown): void {
  const context = ctx as CapacityServices & {
    on(name: 'tools/execute', handler: (exec: {
      name: string
      arguments: unknown
      agent?: Parameters<typeof admitContinuation>[1]
      signal: AbortSignal
    }, next: () => Promise<unknown>) => Promise<unknown>): unknown
  }
  context.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'send_message') return next()
    const target = (exec.arguments as { agent_id?: unknown } | null)?.agent_id
    if (typeof target !== 'string' || target.length === 0) return next()
    const admission = await admitContinuation(context, exec.agent, target, exec.signal)
    if (!admission.admitted) throw new Error(admission.reason)
    try {
      return await next()
    } finally {
      admission.release()
    }
  })
}
