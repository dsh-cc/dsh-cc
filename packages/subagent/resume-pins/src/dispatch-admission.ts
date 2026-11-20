/** Atomic continuation admission after approval, held until delivery settles. */
import { admitContinuation, type CapacityServices } from './live-capacity.ts'
import { resolveSendTarget } from './name-resolution.ts'

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
    const argument = (exec.arguments as { agent?: unknown } | null)?.agent
    if (typeof argument !== 'string' || argument.length === 0) return next()
    // R2 (rc.5): `agent` is a NAME, but the child→parent exemption compares
    // Session ids — resolve best-effort first. Admission can never refuse
    // (the harness pool decides capacity), so an unresolvable argument falls
    // back to the raw token: that preserves the per-parent lease
    // serialization in compositions without a resolver and can never block
    // a legitimate message.
    const target = (await resolveSendTarget(context, exec.agent, argument, exec.signal)) ?? argument
    const admission = await admitContinuation(context, exec.agent, target, exec.signal)
    if (!admission.admitted) throw new Error(admission.reason)
    try {
      return await next()
    } finally {
      admission.release()
    }
  })
}
