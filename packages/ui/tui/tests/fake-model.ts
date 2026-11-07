/**
 * AgentModel work-alike for structural driver fakes (harness-0.2.2 D3.1):
 * creation-options fallback plus the recorded `select` winning on later
 * reads — the same precedence the real `AgentModel.current()` applies
 * (recorded durable selection > options). Specs seed the fake agent's
 * `model` field with it so the driver's live selection face works verbatim.
 */
export interface FakeSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export function fakeAgentModel(options: { provider?: string; model?: string; reasoningEffort?: string }): {
  current(): FakeSelection | undefined
  select(next: FakeSelection): void
} {
  let recorded: FakeSelection | undefined
  return {
    current() {
      if (recorded !== undefined) return { ...recorded }
      const { provider, model, reasoningEffort } = options
      if (provider === undefined || model === undefined) return undefined
      return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    },
    select(next) {
      recorded = { ...next }
    },
  }
}

/**
 * A DriverModelSelection-shaped standalone face (the shape the extracted
 * sections consume via their `*.Ctx`), backed by a mutable holder: pass the
 * holder the fake agent's `model` work-alike, or a bare options object.
 */
export function fakeDriverSelection(seed: { provider?: string; model?: string; reasoningEffort?: string } = {}): {
  current(): FakeSelection | undefined
  selectUser(next: FakeSelection): void
  /** Every user write (selectUser calls), in order. */
  userSelections: FakeSelection[]
} & ReturnType<typeof fakeAgentModel> {
  const base = fakeAgentModel(seed)
  const userSelections: FakeSelection[] = []
  return {
    ...base,
    userSelections,
    selectUser(next) {
      userSelections.push({ ...next })
      base.select(next)
    },
  }
}
