import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@dsh-cc/tools'
import UserQuestionService, {
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'

/**
 * cc-shell bundle smoke for the AI-human interaction rows: the
 * `@deepseek-ai/dsh-user-questions` seam (ctx.userQuestions) is the one active
 * provider slot, and `@deepseek-ai/dsh-tool-ask-user` registers the model-facing
 * `ask_user_question` tool over it. The seam must mount before the tool that
 * injects it; the UI provider is owned by the host app and mounts via
 * registerProvider() rather than a bundle row — with none registered, `ask`
 * surfaces a graceful NO_PROVIDER tool error instead of crashing the host.
 */

/**
 * Mount the vendored ToolRuntime swap (requires systemPrompt) + the
 * user-questions seam + the ask_user_question tool. Order mirrors upstream:
 * SystemPrompt → ToolRuntime → UserQuestionService → toolAskUser.
 */
async function mountAskUser(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ToolAskUser)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

/**
 * Scripted provider that records each request and returns the given answer.
 * Mirrors upstream provider injection: the host app owns the one active slot.
 */
function scriptedProvider(seen: AskUserQuestionRequest[], answer: AskUserQuestionAnswer): UserQuestionProvider {
  return {
    async ask(request) {
      seen.push(request)
      return answer
    },
  }
}

describe('cc-shell bundle — ask_user_question rows (dsh-user-questions + dsh-tool-ask-user)', () => {
  it('mounts the seam and registers the ask_user_question tool schema', async () => {
    const { ctx, dispose } = await mountAskUser()
    expect(ctx.userQuestions).toBeDefined()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('ask_user_question')
    const schema = ctx.tools.schemas().find(s => s.name === 'ask_user_question')
    expect(schema?.parameters).toMatchObject({
      type: 'object',
      required: ['questions'],
    })
    await dispose()
  })

  it('asks a registered provider and projects structured answers', async () => {
    const { ctx, dispose } = await mountAskUser()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider(
      scriptedProvider(seen, { answers: [{ id: 'pkg', selected: ['pnpm'] }] }),
    )

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-ask-ok'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'pkg',
          question: 'Which package manager should I use?',
          options: [{ label: 'pnpm', description: 'Use pnpm workspaces.' }],
        }],
      },
    })

    expect(result.isError).toBe(false)
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"answers":[{"id":"pkg","selected":["pnpm"]}]}' }],
    })
    expect(seen).toMatchObject([{
      questions: [{
        id: 'pkg',
        question: 'Which package manager should I use?',
        options: [{ label: 'pnpm', description: 'Use pnpm workspaces.' }],
      }],
    }])
    await dispose()
  })

  it('surfaces NO_PROVIDER as a graceful tool error without crashing the host', async () => {
    const { ctx, dispose } = await mountAskUser()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-ask-no-provider'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'NO_PROVIDER' } },
    })
    // The host context stays alive for further use after the error.
    expect(ctx.tools.get('ask_user_question')).toBeDefined()
    await dispose()
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    const fiber = await ctx.plugin(ToolAskUser)
    expect(ctx.tools.get('ask_user_question')).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get('ask_user_question')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
