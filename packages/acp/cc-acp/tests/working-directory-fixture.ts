// Vendored from @deepseek-ai/dsh-acp (packages/acp/acp/packages/subagent/subagent/tests/working-directory-fixture.ts (local fixture copy))
// Source ref: c1b47e41fcd54d20a0f061df28683bfc29ee24e5 (deepseek-harness, MIT — see LICENSE-harness)
// Copied 2026-10-09. Structural fixes flow from upstream during harness
// migrations; CC-specific divergences must be recorded in DIVERGENCE.md.
import { Context, Service } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Directory selection for orchestration fixtures whose paths are symbolic and whose logs exclude context providers. */
class FixtureWorkingDirectory extends Service {
  private readonly directories = new WeakMap<Session, string>()

  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: Session): string {
    return this.directories.get(session) ?? session?.header.cwd ?? process.cwd()
  }

  async ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return this.get(agent.session)
  }

  async set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const cwd = resolve(this.get(agent.session), path)
    this.directories.set(agent.session, cwd)
    return cwd
  }
}

/** Mount the directory collaborator without filesystem or model-context behavior unrelated to an orchestration test. */
export async function mountWorkingDirectoryFixture(ctx: Context): Promise<void> {
  if (ctx.get('workingDirectory') === undefined) await ctx.plugin(FixtureWorkingDirectory)
}
