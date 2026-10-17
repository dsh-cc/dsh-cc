// Paired self-test for check-model-literals.mjs.
import assert from 'node:assert/strict'
import { ALLOW, findModelLiterals } from './check-model-literals.mjs'

assert.deepEqual(findModelLiterals('a.ts', `const m = 'deepseek-v4-flash'`).map((h) => h.text), ['deepseek-v4-flash'])
assert.equal(findModelLiterals('a.ts', 'const m = `llmbox_ant/deepseek-v4.1-flash`').length, 1)
assert.equal(findModelLiterals('a.ts', `const m = "claude-sonnet-4-5"`).length, 1)
// comments, aliases and model-id substrings in prose never match
assert.equal(findModelLiterals('a.ts', `// 'deepseek-v4-flash'\nconst a = 'haiku'\nconst s = 'see deepseek-v4 docs'`).length, 0)
assert.ok(ALLOW.some((re) => re.test('packages/compat/cc-model-aliases/src/registry.ts')))
assert.ok(ALLOW.some((re) => re.test('packages/ui/tui/src/provider-presets.ts')))
assert.ok(!ALLOW.some((re) => re.test('packages/ui/tui/src/other.ts')))
console.log('check-model-literals self-test: OK')
