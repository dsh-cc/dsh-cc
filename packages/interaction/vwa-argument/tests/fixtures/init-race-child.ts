/**
 * Separate process for the two-writer init race regression (issue #311):
 * stock ProjectStore (no custom io), one JSON line out.
 * Usage: node --import tsx init-race-child.ts <root> <projectId>
 */
import { ProjectStore } from '../../src/store.ts'
import type { ProjectContract } from '../../src/types.ts'

const [, , root, projectId] = process.argv
const CONTRACT: ProjectContract = {
  question: 'race', language: 'en', domain: 'research',
  requiredQuestions: [], plannedCorpus: [], expectedCoreTopics: [], mode: 'draft',
}

const result = new ProjectStore(root, projectId).init(CONTRACT)
console.log(JSON.stringify(result.ok
  ? { ok: true, code: null, message: null, workspaceIdentity: result.data.workspaceIdentity }
  : { ok: false, code: result.code, message: result.message, workspaceIdentity: null }))
