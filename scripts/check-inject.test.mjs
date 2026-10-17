// Paired self-test for check-inject.mjs (node, typescript from node_modules).
import assert from 'node:assert/strict'
import { readEntry, usedServices } from './check-inject.mjs'

// #140 pre-fix shape (advisor-watchdog@7068f9aa^): plugin calls runSideQuery(ctx) with no inject.
const pre140 = `import { runSideQuery } from '@dsh-cc/side-query'
export const name = 'cc-advisor-watchdog'
export function apply(ctx: Context) { ctx.on('x', () => runSideQuery(ctx, {})) }`
assert.deepEqual(readEntry('i.ts', pre140).declared, [])
assert.deepEqual([...usedServices('i.ts', pre140).keys()], ['llm'])
// post-fix
assert.deepEqual(readEntry('i.ts', `export const inject = ['llm']\n${pre140}`).declared, ['llm'])
// comments, strings and types never count
assert.equal(usedServices('c.ts', `// ctx.llm\nconst s = 'ctx.shell'\ntype T = typeof ctx.fs`).size, 0)
// ctx.get('svc') is the sanctioned optional read
assert.equal(usedServices('g.ts', `const l = ctx.get('llm')`).size, 0)
// this.ctx.<svc> counts
assert.deepEqual([...usedServices('t.ts', `class A { f() { this.ctx.sessions.list() } }`).keys()], ['sessions'])
// Object.assign(fn, { inject }) installer may read what it declares
assert.equal(usedServices('o.ts', `const i = Object.assign((ctx) => ctx.sessions.list(), { inject: ['sessions'] })`).size, 0)
assert.deepEqual([...usedServices('o.ts', `const i = Object.assign((ctx) => ctx.shell.x(), { inject: ['sessions'] })`).keys()], ['shell'])
// reviewed per-file ignore
assert.equal(usedServices('p.ts', `// check-inject-ignore: shell — reason\nctx.shell.run()`).size, 0)
// non-plugin module
assert.equal(readEntry('n.ts', `export const x = 1`), null)
console.log('check-inject self-test: OK')
