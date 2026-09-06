import { afterEach, describe, expect, it } from 'vitest'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import CcBasicCompactionEngine, {
  setCompactHint,
  takeCompactHint,
} from '@dsh-cc/compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * The engine subclass is exercised through the prototype chain: the test
 * swaps the upstream `summarize` (whose real body needs a full ctx) for a
 * capturing stub, then calls the CC override on a constructor-less instance
 * and asserts the hint lands on the input passed DOWN to super.
 */
describe('CcBasicCompactionEngine.summarize hint pass-through', () => {
  const original = BasicCompactionEngine.prototype.summarize as unknown as
    (...args: unknown[]) => Promise<unknown>
  const captured: unknown[] = []

  afterEach(() => {
    ;(BasicCompactionEngine.prototype as unknown as Record<string, unknown>).summarize = original
    captured.length = 0
  })

  function installCapture(): void {
    ;(BasicCompactionEngine.prototype as unknown as Record<string, unknown>).summarize =
      async function (input: unknown) {
        captured.push(input)
        return { summary: [] }
      }
  }

  function engine(): CcBasicCompactionEngine {
    // Constructor-less instance: only the method under test runs.
    return Object.create(CcBasicCompactionEngine.prototype) as CcBasicCompactionEngine
  }

  function baseInput(): { system?: string; messages: readonly unknown[] } {
    return {
      system: 's',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
  }

  it('passes a parked hint down to super.summarize and consumes it', async () => {
    installCapture()
    const agent = { id: 'a' } as unknown as Parameters<CcBasicCompactionEngine['summarize']>[1]
    setCompactHint(agent, 'keep file paths verbatim')
    await engine().summarize(baseInput() as never, agent, undefined)
    expect(captured).toHaveLength(1)
    const input = captured[0] as { messages: readonly unknown[] }
    expect(input.messages).toHaveLength(2)
    const last = input.messages.at(-1) as { content: { text: string }[] }
    expect(last.content[0]!.text).toContain('keep file paths verbatim')
    // The hint was consumed by the summarize pass, not left parked.
    expect(takeCompactHint(agent)).toBeUndefined()
  })

  it('passes the input through unchanged when no hint is parked', async () => {
    installCapture()
    const agent = { id: 'a' } as unknown as Parameters<CcBasicCompactionEngine['summarize']>[1]
    const input = baseInput()
    await engine().summarize(input as never, agent, undefined)
    expect(captured[0]).toBe(input)
  })
})
