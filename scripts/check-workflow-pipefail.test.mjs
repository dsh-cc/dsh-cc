// Paired self-test for check-workflow-pipefail.mjs (node, no deps).
import assert from 'node:assert/strict'
import { checkWorkflow } from './check-workflow-pipefail.mjs'

const head = 'on: push\n'
const defaults = 'defaults:\n  run:\n    shell: bash\n'
const job = (step) => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${step}`
const pipeStep = '      - name: t\n        run: |\n          vitest run 2>&1 | tee log\n'

assert.equal(checkWorkflow('ok.yml', head + defaults + job(pipeStep)).length, 0)
assert.match(checkWorkflow('nodef.yml', head + job(pipeStep))[0], /missing top-level/)
const shStep = '      - name: t\n        shell: sh\n        run: |\n          a | b\n'
assert.match(checkWorkflow('sh.yml', head + defaults + job(shStep))[0], /shell: sh with a pipe/)
const shOk = '      - name: t\n        shell: sh\n        run: |\n          set -o pipefail\n          a | b\n'
assert.equal(checkWorkflow('shok.yml', head + defaults + job(shOk)).length, 0)
const orOnly = '      - name: t\n        shell: sh\n        run: a || b\n'
assert.equal(checkWorkflow('or.yml', head + defaults + job(orOnly)).length, 0)
console.log('check-workflow-pipefail self-test: OK')
