import { describe, expect, it } from 'vitest'
import { parseRule } from '../src/parser.ts'
import { evaluatePermission, mergeRuleSets } from '../src/evaluate.ts'
import { PLAN_READONLY_REASON } from '../src/types.ts'
import type { EvaluationInput, PermissionRuleSet } from '../src/types.ts'
import { EMPTY_RULE_SET } from '../src/types.ts'

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    toolName: 'Bash',
    rules: EMPTY_RULE_SET,
    mode: 'default',
    ...overrides,
  }
}

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    bypassImmune: [],
    ...overrides,
  }
}

describe('evaluatePermission ordering', () => {
  it('denies on a whole-tool deny before any content rule', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        deny: [parseRule('Bash', 'deny', 'config')],
        allow: [parseRule('Bash(npm install)', 'allow', 'userSettings')],
      }),
      subject: 'npm install',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('a whole-tool allow admits any subject not caught by a more specific rule', () => {
    const matched = evaluatePermission(input({
      rules: rules({
        allow: [parseRule('Bash', 'allow', 'config')],
        deny: [parseRule('Bash(rm -rf)', 'deny', 'userSettings')],
      }),
      subject: 'echo hi',
    }))
    expect(matched).toMatchObject({ kind: 'allow' })
    // The content deny is more specific and still blocks its own subject.
    const blocked = evaluatePermission(input({
      rules: rules({
        allow: [parseRule('Bash', 'allow', 'config')],
        deny: [parseRule('Bash(rm -rf)', 'deny', 'userSettings')],
      }),
      subject: 'rm -rf /tmp/x',
    }))
    expect(blocked).toMatchObject({ kind: 'deny' })
  })

  it('asks on a whole-tool ask', () => {
    const decision = evaluatePermission(input({
      rules: rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
    }))
    expect(decision).toMatchObject({ kind: 'ask' })
  })

  it('skips a whole-tool ask for an exempted sandboxed bash', () => {
    const decision = evaluatePermission(input({
      rules: rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
      sandboxedBashExempt: true,
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('does not skip the ask when no subject (whole-tool) and notify the exemption is route-specific', () => {
    const notExempt = evaluatePermission(input({
      toolName: 'Edit',
      rules: rules({ ask: [parseRule('Edit', 'ask', 'config')] }),
      sandboxedBashExempt: true,
    }))
    expect(notExempt).toMatchObject({ kind: 'ask' })
  })

  it('passes through when nothing matches', () => {
    const decision = evaluatePermission(input({ subject: 'ls' }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })
})

describe('bypass-immune rules', () => {
  it('denies before the approval/check ordering and before bypassPermissions mode', () => {
    const decision = evaluatePermission(input({
      toolName: 'Edit',
      rules: rules({ bypassImmune: [parseRule('Edit(.git*)', 'deny', 'config')] }),
      subject: '.git/config',
      mode: 'bypassPermissions',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('allows a non-matching subject under bypassPermissions', () => {
    const decision = evaluatePermission(input({
      toolName: 'Edit',
      rules: rules({ bypassImmune: [parseRule('Edit(.git*)', 'deny', 'config')] }),
      subject: 'src/main.ts',
      mode: 'bypassPermissions',
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })
})

describe('content-level rules by source priority', () => {
  it('higher-priority source decides first — but deny-first: a config deny beats a userSettings allow (D2 flip)', () => {
    // userSettings (higher) allows the prefix; config (lower) denies it.
    // Behavior-outer ordering (deny before allow) outranks source priority.
    const decision = evaluatePermission(input({
      rules: rules({
        deny: [parseRule('Bash(npm install)', 'deny', 'config')],
        allow: [parseRule('Bash(npm install)', 'allow', 'userSettings')],
      }),
      subject: 'npm install --save x',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('content-deny beats a same-source allow (D2)', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        allow: [parseRule('Bash(npm install)', 'allow', 'userSettings')],
        deny: [parseRule('Bash(npm install)', 'deny', 'userSettings')],
      }),
      subject: 'npm install --save x',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('content-deny beats a whole-tool ask (D2)', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        ask: [parseRule('Bash', 'ask', 'config')],
        deny: [parseRule('Bash(npm install)', 'deny', 'userSettings')],
      }),
      subject: 'npm install --save x',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('sandbox-exempt bash + content deny ⇒ deny (exemption only lifts asks, D2)', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        deny: [parseRule('Bash(npm install)', 'deny', 'config')],
      }),
      subject: 'npm install --save x',
      sandboxedBashExempt: true,
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('content-ask beats a lower-priority content-allow across sources (D2)', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        ask: [parseRule('Bash(npm install)', 'ask', 'userSettings')],
        allow: [parseRule('Bash(npm install)', 'allow', 'config')],
      }),
      subject: 'npm install --save x',
    }))
    expect(decision).toMatchObject({ kind: 'ask' })
  })

  it('falls to a lower-priority source when the higher one does not match', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        deny: [parseRule('Bash(npm install)', 'deny', 'userSettings')],
        allow: [parseRule('Bash(npm publish)', 'allow', 'config')],
      }),
      subject: 'npm publish foo',
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('asks at content level when a high-priority ask matches', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        ask: [parseRule('Bash(rm -rf)', 'ask', 'userSettings')],
        allow: [parseRule('Bash(rm -rf)', 'allow', 'config')],
      }),
      subject: 'rm -rf /tmp/x',
    }))
    expect(decision).toMatchObject({ kind: 'ask' })
  })
})

describe('modes', () => {
  it('acceptEdits auto-allows a file-edit call', () => {
    const decision = evaluatePermission(input({
      toolName: 'edit',
      isFileEdit: true,
      mode: 'acceptEdits',
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('acceptEdits does not allow a non-edit call without a matching rule', () => {
    const decision = evaluatePermission(input({
      toolName: 'Bash',
      mode: 'acceptEdits',
      subject: 'curl http://x',
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })

  it('plan auto-allows a read-only call', () => {
    const decision = evaluatePermission(input({
      toolName: 'read',
      isReadOnly: true,
      mode: 'plan',
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('bypassPermissions allows everything with no matching rule', () => {
    const decision = evaluatePermission(input({
      subject: 'some arbitrary command',
      mode: 'bypassPermissions',
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('bypassDisabled downgrades bypassPermissions to default (passthrough)', () => {
    const decision = evaluatePermission(input({
      subject: 'some arbitrary command',
      mode: 'bypassPermissions',
      bypassDisabled: true,
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })

  it('plan denies a non-read-only call with the exit_plan_mode reason', () => {
    const decision = evaluatePermission(input({
      toolName: 'Bash',
      subject: 'npm install',
      mode: 'plan',
    }))
    expect(decision).toEqual({ kind: 'deny', reason: PLAN_READONLY_REASON })
  })

  it('plan denies a file-edit call (not read-only) with the same reason', () => {
    const decision = evaluatePermission(input({
      toolName: 'edit',
      isFileEdit: true,
      mode: 'plan',
    }))
    expect(decision).toEqual({ kind: 'deny', reason: PLAN_READONLY_REASON })
  })

  it('auto behaves identically to default (passthrough with no rules)', () => {
    const decision = evaluatePermission(input({
      subject: 'ls',
      mode: 'auto',
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })

  it('auto still honors a whole-tool deny', () => {
    const decision = evaluatePermission(input({
      rules: rules({ deny: [parseRule('Bash(rm -rf)', 'deny', 'config')] }),
      subject: 'rm -rf /tmp/x',
      mode: 'auto',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('plan still admits a whole-tool allow for a non-read-only call', () => {
    const decision = evaluatePermission(input({
      toolName: 'Bash',
      subject: 'npm install',
      mode: 'plan',
      rules: rules({ allow: [parseRule('Bash', 'allow', 'config')] }),
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('plan converts a leftover whole-tool ask into the read-only deny', () => {
    const decision = evaluatePermission(input({
      toolName: 'Bash',
      subject: 'npm install',
      mode: 'plan',
      rules: rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
    }))
    expect(decision).toEqual({ kind: 'deny', reason: PLAN_READONLY_REASON })
  })
})

describe('CC-vs-harness tool-name alias matching', () => {
  it('matches a CC-cased `Bash(npm run *)` rule against harness exec.name `bash`', () => {
    const decision = evaluatePermission(input({
      toolName: 'bash',
      rules: rules({
        deny: [parseRule('Bash(npm run *)', 'deny', 'config')],
        allow: [parseRule('Bash', 'allow', 'config')],
      }),
      subject: 'npm run build',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('matches a lowercase-authored `bash(...)` rule too', () => {
    const decision = evaluatePermission(input({
      toolName: 'bash',
      rules: rules({
        deny: [parseRule('bash(npm run *)', 'deny', 'config')],
      }),
      subject: 'npm run build',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('matches a CC-cased `Edit(...)` rule against harness exec.name `edit`', () => {
    const decision = evaluatePermission(input({
      toolName: 'edit',
      rules: rules({
        deny: [parseRule('Edit(a.ts)', 'deny', 'config')],
        allow: [parseRule('Edit', 'allow', 'config')],
      }),
      subject: 'a.ts',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('fires the sandboxed-bash exemption for harness exec.name `bash` against the default `Bash` alias', () => {
    const decision = evaluatePermission(input({
      toolName: 'bash',
      rules: rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
      sandboxedBashExempt: true,
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })
})

describe('mergeRuleSets', () => {
  it('orders rules by source priority within each behavior', () => {
    const merged = mergeRuleSets(
      { allow: [parseRule('Bash(npm install)', 'allow', 'config')], deny: [], ask: [], bypassImmune: [] },
      { allow: [parseRule('Bash(npm install)', 'allow', 'userSettings')], deny: [], ask: [], bypassImmune: [] },
    )
    expect(merged.allow.map(rule => rule.source)).toEqual(['userSettings', 'config'])
  })

  it('preserves bypassImmune rules', () => {
    const merged = mergeRuleSets(
      { allow: [], deny: [], ask: [], bypassImmune: [parseRule('Edit(.git*)', 'deny', 'config')] },
    )
    expect(merged.bypassImmune).toHaveLength(1)
  })
})
