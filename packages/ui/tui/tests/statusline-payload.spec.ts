import { describe, expect, it } from 'vitest'
import { buildStatusLinePayload, type StatusLinePayloadView } from '../src/harness/statusline-payload.ts'
import { lastBucketsOf } from '../src/harness/usage-view.ts'

/** A minimal concrete view; individual tests spread overrides over it. */
function view(overrides: Partial<StatusLinePayloadView> = {}): StatusLinePayloadView {
  return {
    version: '0.4.1-test',
    bindTimeMs: 1_000_000,
    nowMs: 1_005_000,
    ...overrides,
  }
}

describe('buildStatusLinePayload', () => {
  it('emits the full CC-shaped payload from a full view', () => {
    const payload = buildStatusLinePayload(view({
      sessionId: 'sess-1',
      sessionCwd: '/repo/sub',
      driverCwd: '/repo',
      projectDir: '/repo',
      transcriptPath: '/home/.dsh/sessions/sess-1.jsonl',
      model: 'deepseek-v3',
      effort: 'high',
      outputStyleName: 'explanatory',
      gitWorktree: 'status-line',
      worktree: { name: 'status-line', path: '/repo/.claude/worktrees/status-line', branch: 'worktree-status-line' },
      inputTokens: 123_456,
      outputTokens: 2_345,
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
      sessionCreatedAtMs: 900_000,
    }))
    expect(payload).toEqual({
      cwd: '/repo/sub',
      session_id: 'sess-1',
      transcript_path: '/home/.dsh/sessions/sess-1.jsonl',
      model: { id: 'deepseek-v3', display_name: 'deepseek-v3' },
      workspace: {
        current_dir: '/repo/sub',
        project_dir: '/repo',
        added_dirs: [],
        git_worktree: 'status-line',
      },
      version: '0.4.1-test',
      output_style: { name: 'explanatory' },
      cost: { total_duration_ms: 105_000 },
      context_window: {
        total_input_tokens: 123_456,
        total_output_tokens: 2_345,
        context_window_size: 200_000,
        used_percentage: 65,
        remaining_percentage: 35,
      },
      exceeds_200k_tokens: false,
      effort: { level: 'high' },
      worktree: { name: 'status-line', path: '/repo/.claude/worktrees/status-line', branch: 'worktree-status-line' },
    })
  })

  it('drops absent sources field-by-field and drops empty sub-objects wholesale', () => {
    const payload = buildStatusLinePayload(view())
    // Only truthfully-sourced fields survive; absent ones are dropped.
    expect(payload).toEqual({
      // The bind-time duration fallback is still truthful, so `cost` stays.
      cost: { total_duration_ms: 5_000 },
      workspace: { added_dirs: [] },
      version: '0.4.1-test',
    })
    expect('cwd' in payload).toBe(false)
    expect('model' in payload).toBe(false)
    expect('context_window' in payload).toBe(false)
    expect('effort' in payload).toBe(false)
    expect('session_id' in payload).toBe(false)
    expect('transcript_path' in payload).toBe(false)
    expect('output_style' in payload).toBe(false)
    expect('worktree' in payload).toBe(false)
    // exceeds_200k_tokens is omitted when neither a currentUsage-derived
    // context length nor a pressure sample exists.
    expect('exceeds_200k_tokens' in payload).toBe(false)
  })
})

describe('version (pinned v1 omission — no truthful runtime source)', () => {
  it('drops the version field when the view carries none', () => {
    const payload = buildStatusLinePayload({ bindTimeMs: 1_000_000, nowMs: 1_005_000 })
    expect('version' in payload).toBe(false)
  })
})

describe('exceeds_200k_tokens (context length: currentUsage-derived, else pressure)', () => {
  it('is true when the currentUsage-derived context length exceeds 200000', () => {
    const payload = buildStatusLinePayload(view({
      currentUsage: { inputTokens: 150_000, outputTokens: 5_000, cacheReadTokens: 60_000 },
    }))
    expect(payload.exceeds_200k_tokens).toBe(true)
  })

  it('is false at 200000 and true at 200001 of context length', () => {
    expect(buildStatusLinePayload(view({
      currentUsage: { inputTokens: 150_000, outputTokens: 5_000, cacheReadTokens: 50_000 },
    })).exceeds_200k_tokens).toBe(false)
    expect(buildStatusLinePayload(view({
      currentUsage: { inputTokens: 150_000, outputTokens: 5_000, cacheReadTokens: 50_001 },
    })).exceeds_200k_tokens).toBe(true)
  })

  it('falls back to pressureTokens when no currentUsage exists', () => {
    expect(buildStatusLinePayload(view({ pressureTokens: 200_000 })).exceeds_200k_tokens).toBe(false)
    expect(buildStatusLinePayload(view({ pressureTokens: 200_001 })).exceeds_200k_tokens).toBe(true)
  })

  it('is omitted when neither source exists (cumulative input alone no longer decides)', () => {
    expect('exceeds_200k_tokens' in buildStatusLinePayload(view({ inputTokens: 500_000 }))).toBe(false)
    expect('exceeds_200k_tokens' in buildStatusLinePayload(view())).toBe(false)
  })
})

describe('moa (additive non-CC key)', () => {
  it('carries the moa tier when the view supplies one', () => {
    const payload = buildStatusLinePayload(view({ moa: { tier: 'draft' } }))
    expect(payload.moa).toEqual({ tier: 'draft' })
  })

  it('carries the effective model id alongside the tier when known (effective-model-truth §5.4)', () => {
    const payload = buildStatusLinePayload(view({ moa: { tier: 'sketch', model: 'deepseek-v4.1-flash' } }))
    expect(payload.moa).toEqual({ tier: 'sketch', model: 'deepseek-v4.1-flash' })
  })

  it('drops the moa field entirely when unset', () => {
    expect('moa' in buildStatusLinePayload(view())).toBe(false)
  })
})

describe('cost.total_duration_ms', () => {
  it('derives from the session createdAt, not the bind time', () => {
    // bind→now is 5s, session createdAt→now is 105s: the session clock wins.
    const payload = buildStatusLinePayload(view({ sessionCreatedAtMs: 900_000 }))
    expect(payload.cost).toEqual({ total_duration_ms: 105_000 })
  })

  it('falls back to bind time when the session carries no createdAt', () => {
    const payload = buildStatusLinePayload(view())
    expect(payload.cost).toEqual({ total_duration_ms: 5_000 })
  })
})

describe('context_window percentages', () => {
  it('derives used/remaining from pressure over window', () => {
    const payload = buildStatusLinePayload(view({
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
    }))
    expect(payload.context_window).toMatchObject({ used_percentage: 65, remaining_percentage: 35 })
  })

  it('drops the whole sub-object when only percentages are unknown', () => {
    const payload = buildStatusLinePayload(view({ pressureTokens: 1_000 }))
    expect('context_window' in payload).toBe(false)
  })

  it('prefers the currentUsage-derived context length over pressureTokens', () => {
    // Context length = 100_000 + 20_000 (cache write) + 30_000 (cache read)
    // = 150_000 over a 200_000 window → 75% used, 25% remaining.
    const payload = buildStatusLinePayload(view({
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
      currentUsage: {
        inputTokens: 100_000,
        outputTokens: 1_000,
        cacheWriteTokens: 20_000,
        cacheReadTokens: 30_000,
      },
    }))
    expect(payload.context_window).toMatchObject({ used_percentage: 75, remaining_percentage: 25 })
  })

  it('drops the percentages when the context window is absent or non-positive', () => {
    const payload = buildStatusLinePayload(view({
      currentUsage: { inputTokens: 100, outputTokens: 10 },
      pressureTokens: 130_000,
    }))
    expect(payload.context_window).toEqual({
      current_usage: { input_tokens: 100, output_tokens: 10 },
    })
  })
})

describe('context_window.current_usage (CC field names for the last step\'s buckets)', () => {
  it('emits current_usage with the exact CC cache field names', () => {
    const payload = buildStatusLinePayload(view({
      currentUsage: {
        inputTokens: 1_234,
        outputTokens: 345,
        cacheWriteTokens: 78,
        cacheReadTokens: 56,
      },
    }))
    expect((payload.context_window as Record<string, unknown>).current_usage).toEqual({
      input_tokens: 1_234,
      output_tokens: 345,
      cache_creation_input_tokens: 78,
      cache_read_input_tokens: 56,
    })
  })

  it('omits the cache keys when the buckets carry no cache fields', () => {
    const payload = buildStatusLinePayload(view({
      currentUsage: { inputTokens: 1_234, outputTokens: 345 },
    }))
    expect((payload.context_window as Record<string, unknown>).current_usage).toEqual({
      input_tokens: 1_234,
      output_tokens: 345,
    })
  })

  it('drops current_usage (and only it) when the view carries none', () => {
    const payload = buildStatusLinePayload(view({
      inputTokens: 1_234,
      outputTokens: 345,
    }))
    expect(payload.context_window).toEqual({ total_input_tokens: 1_234, total_output_tokens: 345 })
  })
})

describe('JSON round-trip', () => {
  it('stays small and survives a round-trip unchanged', () => {
    const payload = buildStatusLinePayload(view({
      sessionId: 'sess-1',
      sessionCwd: '/repo/sub',
      model: 'deepseek-v3',
      inputTokens: 123_456,
      contextWindowTokens: 200_000,
      pressureTokens: 130_000,
    }))
    const text = JSON.stringify(payload)
    expect(text.length).toBeLessThan(2 * 1024)
    expect(JSON.parse(text)).toEqual(payload)
  })
})

describe('lastBucketsOf (no usage-view spec exists — cases live in the payload-adjacent suite)', () => {
  const buckets = {
    uncachedInputTokens: 1_234,
    outputTokens: 345,
    cacheReadTokens: 56,
    cacheWriteTokens: 78,
  }

  it('maps the last step\'s buckets, accepting the harness field name for input', () => {
    expect(lastBucketsOf({ last: { turn: 3, step: 1, buckets } })).toEqual({
      inputTokens: 1_234,
      outputTokens: 345,
      cacheReadTokens: 56,
      cacheWriteTokens: 78,
    })
  })

  it('accepts the defensive inputTokens field name', () => {
    expect(lastBucketsOf({
      last: { turn: 3, step: 1, buckets: { ...buckets, uncachedInputTokens: undefined, inputTokens: 999 } },
    })).toMatchObject({ inputTokens: 999 })
  })

  it('drops cache fields that are not finite numbers', () => {
    const mapped = lastBucketsOf({
      last: { turn: 3, step: 1, buckets: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: Number.NaN } },
    })
    expect(mapped).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it('returns undefined when input or output are missing or non-finite', () => {
    expect(lastBucketsOf(undefined)).toBeUndefined()
    expect(lastBucketsOf({ last: null })).toBeUndefined()
    expect(lastBucketsOf({ last: { turn: 1, step: 1, buckets: { outputTokens: 2 } } })).toBeUndefined()
    expect(lastBucketsOf({ last: { turn: 1, step: 1, buckets: { uncachedInputTokens: 1 } } })).toBeUndefined()
    expect(lastBucketsOf({
      last: { turn: 1, step: 1, buckets: { uncachedInputTokens: Number.NaN, outputTokens: 2 } },
    })).toBeUndefined()
  })
})
