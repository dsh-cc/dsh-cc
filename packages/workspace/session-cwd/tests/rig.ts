/**
 * Shared real-service rig for the session-cwd tests: a real cordis
 * composition with the genuine `sessionProjections` registry, `fs` backend and
 * `workingDirectory` service, plus a minimal `systemPrompt` stub the service
 * construction requires. Agents are lightweight faces over real Sessions (the
 * service only needs `session`, `ctx.fiber` and `inject`).
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'

/** The subset of `systemPrompt` the workingDirectory service touches. */
class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  getContextOrder(): number {
    return 0
  }

  context(): void {}

  variable(): void {}
}

/** One mounted real-service composition. */
export interface ServiceRig {
  readonly ctx: Context
  readonly service: WorkingDirectory
  /** A fresh session whose header carries `cwd` (when given). */
  session(cwd?: string): Session
  /** A bare agent face bound to `ctx` (the real service composition). */
  agent(session: Session, ctx?: Context): Agent
}

/**
 * Mount the genuine working-directory stack on a fresh root context.
 * @param options - optional deployment default directory.
 * @returns the rig.
 */
export async function serviceRig(options: { defaultDirectory?: string } = {}): Promise<ServiceRig> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  ctx.provide('systemPrompt', new StubSystemPrompt(new Context()) as never)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: options.defaultDirectory ?? process.cwd() })
  const service = ctx.get('workingDirectory') as WorkingDirectory
  let counter = 0
  return {
    ctx,
    service,
    session: cwd => {
      const id = SessionId(`rig-${++counter}`)
      const header = { version: 4, id, createdAt: Date.now(), isSeeded: false, ...(cwd === undefined ? {} : { cwd }) }
      return Session.create(id, [], header as never)
    },
    agent: (session, agentCtx = ctx) => ({ session, ctx: agentCtx, inject() {} }) as unknown as Agent,
  }
}

/** A real temp directory (raw spelling; macOS tmpdirs live under `/var`). */
export function tempDir(prefix = 'session-cwd-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A real directory `name` inside `root`, created. */
export function subdir(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
