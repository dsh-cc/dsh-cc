import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { canonicalJson, PrefixTracker } from '@dsh-cc/cache-health/tracker'

/**
 * Assumption pin: message-hash ⟺ wire-prefix.
 *
 * The observer assumes that a session's Message list serializes
 * deterministically — i.e. two identical Message lists produce identical
 * hashes, so "hash unchanged" really means "wire prefix unchanged". The
 * deepseek adapter's `serializeMessages` (llm-deepseek/src/serialize.ts) is
 * NOT exported from the package's public surface, so the pin lives at the
 * level that IS public: our canonical serializer's determinism over the same
 * Message list, plus the tracker's session-level identity. If a future
 * harness change makes wire expansion order- or shape-dependent (e.g.
 * reordering tools, injecting per-request ids), the wire-prefix assumption
 * breaks and this ledger under-reports churn — extend this pin then.
 */
describe('message-hash ⟺ wire-prefix assumption', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } as Message,
    { role: 'user', content: [{ type: 'text', text: 'again' }] } as Message,
  ]

  it('the same Message list canonicalizes identically, twice', () => {
    expect(canonicalJson(messages)).toBe(canonicalJson(structuredClone(messages)))
    expect(canonicalJson(messages)).toBe(canonicalJson(messages))
  })

  it('the tracker reports identical Message lists as fully stable across calls', () => {
    const tracker = new PrefixTracker()
    const first = tracker.observe('s1', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages,
      system: 'sys',
    } as Parameters<PrefixTracker['observe']>[1])
    const second = tracker.observe('s1', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: structuredClone(messages),
      system: 'sys',
    } as Parameters<PrefixTracker['observe']>[1])
    expect(second.prefixChanged).toBe(false)
    expect(second.stableSegments).toBe(first.stableSegments)
  })
})
