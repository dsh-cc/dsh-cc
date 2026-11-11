// Paired self-test for check-workflow-node.mjs (node, no deps).
import assert from 'node:assert/strict'
import { checkWorkflow, parseVersion, readFloorRange, readPrimaryLine } from './check-workflow-node.mjs'

const policy = { primary: '24', floor: { major: 22, minor: 19 } }
const flow = (jobs) => `name: t\non: push\njobs:\n${jobs}`
const job = (id, steps) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
const setup = (body) => `      - uses: actions/setup-node@v4\n        with:\n${body}`
const one = (body) => flow(job('a', setup(body)))

// --- helpers ---------------------------------------------------------------
assert.equal(readPrimaryLine('24\n'), '24')
assert.equal(readPrimaryLine('# comment\n\n24.22.2\n'), '24.22.2')
assert.equal(readPrimaryLine('# only comments\n\n'), undefined)

assert.deepEqual(readFloorRange('^22.19 || >=24'), { major: 22, minor: 19 })
assert.deepEqual(readFloorRange('>=24.9.0'), { major: 24, minor: 9 })
assert.deepEqual(readFloorRange('^20 || ^22 || >=24'), { major: 20, minor: undefined })
assert.equal(readFloorRange(undefined), undefined)

assert.deepEqual(parseVersion('24'), { major: 24, minor: undefined })
assert.deepEqual(parseVersion('"v22.19.0"'), { major: 22, minor: 19 })
assert.equal(parseVersion('lts/*'), undefined)

// --- accepted forms -------------------------------------------------------
assert.equal(checkWorkflow('file.yml', one('          node-version-file: dsh-cc/.nvmrc\n'), policy).length, 0)
assert.equal(checkWorkflow('primary.yml', one('          node-version: 24   # comment\n'), policy).length, 0)
assert.equal(checkWorkflow('floor.yml', one('          node-version: 22\n'), policy).length, 0)
assert.equal(checkWorkflow('floor-minor.yml', one('          node-version: 22.19.0\n'), policy).length, 0)
assert.equal(checkWorkflow('quoted.yml', one('          node-version: "22"\n'), policy).length, 0)
assert.equal(
  checkWorkflow('matrix.yml', one('          node-version: ${{ matrix.node }}\n'), policy).length,
  0,
  'a matrix expression resolves at run time and must not be reported',
)

// A step whose `uses:` follows a `- name:` line is still a setup-node step.
const named = (body) => `      - name: Setup Node\n        uses: actions/setup-node@v4\n        with:\n${body}`
assert.equal(checkWorkflow('named.yml', flow(job('a', named('          node-version-file: .nvmrc\n'))), policy).length, 0)
const namedStale = checkWorkflow('named-stale.yml', flow(job('a', named('          node-version: 20\n'))), policy)
assert.equal(namedStale.length, 1, 'a named step must not hide its literal')
assert.match(namedStale[0], /node-version: 20/)

// A job-level `uses:` is a reusable workflow: no steps, so no requirement.
const reusable = flow('  call:\n    uses: dsh-cc/dsh-cc/.github/workflows/presubmit.yml@main\n')
assert.equal(checkWorkflow('reusable.yml', reusable, policy).length, 0)

// --- violations -----------------------------------------------------------
const noSetup = checkWorkflow('bare.yml', flow(job('a', '      - run: node --version\n')), policy)
assert.equal(noSetup.length, 1)
assert.match(noSetup[0], /no `actions\/setup-node` step/)
assert.match(noSetup[0], /bare\.yml:4: job `a`/)

// Rule 1 is per job: a second job without its own setup-node must fail even
// though the file already contains one.
const secondJobBare = flow(
  job('a', setup('          node-version-file: .nvmrc\n')) + job('b', '      - run: node --version\n'),
)
const secondJobProblems = checkWorkflow('two-jobs.yml', secondJobBare, policy)
assert.equal(secondJobProblems.length, 1)
assert.match(secondJobProblems[0], /two-jobs\.yml:10: job `b`/)

const undeclared = checkWorkflow('undeclared.yml', one('          cache: pnpm\n'), policy)
assert.match(undeclared[0], /declares neither `node-version-file` nor `node-version`/)

const both = checkWorkflow('both.yml', one('          node-version: 24\n          node-version-file: .nvmrc\n'), policy)
assert.match(both[0], /declares both `node-version` and `node-version-file`/)

const stale = checkWorkflow('stale.yml', one('          node-version: 20   # old pin\n'), policy)
assert.match(stale[0], /neither the primary line .* nor the engines floor \(22\.19\)/)
assert.match(stale[0], /stale\.yml:9/)

const future = checkWorkflow('future.yml', one('          node-version: 26\n'), policy)
assert.equal(future.length, 1, 'an undeclared future major is still a violation until .nvmrc moves')

// A pin below the engines minor (`^22.19`) is not the floor.
const tooOld = checkWorkflow('too-old.yml', one('          node-version: 22.0.0\n'), policy)
assert.equal(tooOld.length, 1)
assert.match(tooOld[0], /engines floor \(22\.19\)/)

// Garbage literals are violations, not silently accepted.
const garbage = checkWorkflow('garbage.yml', one('          node-version: lts/*\n'), policy)
assert.equal(garbage.length, 1)

// A workflow with no jobs block at all is a violation.
assert.match(checkWorkflow('nojobs.yml', 'name: t\non: push\n', policy)[0], /no `jobs:` block found/)

console.log('check-workflow-node self-test: OK')
