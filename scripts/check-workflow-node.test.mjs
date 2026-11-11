// Paired self-test for check-workflow-node.mjs (node, no deps).
import assert from 'node:assert/strict'
import { checkWorkflow, readFloorMajor, readPrimaryLine } from './check-workflow-node.mjs'

const lines = { primary: '24', floorMajor: 22 }
const job = (step) => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${step}`
const setup = (body) => job(`      - uses: actions/setup-node@v4\n        with:\n${body}`)

// --- helpers ---------------------------------------------------------------
assert.equal(readPrimaryLine('24\n'), '24')
assert.equal(readPrimaryLine('# comment\n\n24.22.2\n'), '24.22.2')
assert.equal(readPrimaryLine('# only comments\n\n'), undefined)
assert.equal(readFloorMajor('^22.19 || >=24'), 22)
assert.equal(readFloorMajor('>=24.9.0'), 24)
assert.equal(readFloorMajor(undefined), undefined)

// --- accepted forms -------------------------------------------------------
assert.equal(checkWorkflow('file.yml', setup('          node-version-file: dsh-cc/.nvmrc\n'), lines).length, 0)
assert.equal(checkWorkflow('primary.yml', setup('          node-version: 24   # comment\n'), lines).length, 0)
assert.equal(checkWorkflow('floor.yml', setup('          node-version: 22\n'), lines).length, 0)
assert.equal(checkWorkflow('floor-patch.yml', setup('          node-version: 22.19.0\n'), lines).length, 0)

// --- violations -----------------------------------------------------------
const noSetup = checkWorkflow('bare.yml', job('      - run: node --version\n'), lines)
assert.match(noSetup[0], /no `actions\/setup-node` step/)

const undeclared = checkWorkflow('undeclared.yml', setup('          cache: pnpm\n'), lines)
assert.match(undeclared[0], /declares neither `node-version-file` nor `node-version`/)

const both = checkWorkflow('both.yml', setup('          node-version: 24\n          node-version-file: .nvmrc\n'), lines)
assert.match(both[0], /declares both `node-version` and `node-version-file`/)

const stale = checkWorkflow('stale.yml', setup('          node-version: 20   # old pin\n'), lines)
assert.match(stale[0], /neither the primary line .* nor the engines floor \(22\)/)
assert.match(stale[0], /stale\.yml:7/)

const future = checkWorkflow('future.yml', setup('          node-version: 26\n'), lines)
assert.equal(future.length, 1, 'an undeclared future major is still a violation until .nvmrc moves')

// --- the checked-in workflows must satisfy the policy they encode ----------
// (The main entry point enforces this; asserting the message shape here keeps
// the self-test honest about what the gate reports.)
const real = setup('          node-version-file: .nvmrc\n          cache: pnpm\n')
assert.equal(checkWorkflow('real.yml', real, lines).length, 0)

console.log('check-workflow-node self-test: OK')
