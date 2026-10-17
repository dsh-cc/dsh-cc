import {describe,it,expect} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ReviewRunStore} from '../src/review-run-store.ts'

describe('persisted usage recovers a reserve even if request counters were not updated',()=>{
  it('an interrupted call remains charged after reopening the store',()=>{
    const root=mkdtempSync(join(tmpdir(),'vwa-reserve-')),store=new ReviewRunStore(root,'prj_recovery')
    store.initRun('run_recovery')
    store.writeRequest('run_recovery',{schemaVersion:1,requestId:'request',runId:'run_recovery',stage:'claims',targetClaimIds:[],status:'running',inputTokens:0,outputTokens:0,calls:0,startedAt:''})
    store.appendUsage('run_recovery',{runId:'run_recovery',taskId:'task_one',seq:1,kind:'reserved',inputTokens:42,outputTokens:3000,method:'bytes-upper-bound'})
    expect(new ReviewRunStore(root,'prj_recovery').loadRequest('run_recovery')).toMatchObject({status:'incomplete',calls:1,inputTokens:42,outputTokens:3000})
  })
})
