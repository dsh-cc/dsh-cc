/** Cross-stage acceptance: public runner -> persisted records -> report -> receipt. */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { executeReviewRun } from '../src/review-runner.ts'
import { VwaArgumentService } from '../src/report.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { registerArgumentTools } from '../src/tools.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { buildReceiptV2, writeReceiptV2 } from '@dsh-cc/vwa-evidence'
import { makeClaim, makeSource, makeEvidence, makeGroup, fakeAdapter, BUDGET, claimsResponse } from './review-helpers.ts'
import { initWorkspace } from './helpers.ts'

function fixture() {
  const made=initWorkspace(),claim=makeClaim('fact','The council closed the port in May.')
  const source=makeSource(),text='The council voted to close the port on 3 May.\n'
  source.snapshotHash=sha256Hex(text);source.snapshotPath=`docs/vwa-sources/${made.projectId}/${source.id}.md`
  writeFileSync(join(made.root,source.snapshotPath),text)
  const evidence=makeEvidence(source);evidence.span={start:0,end:text.length};evidence.contextSpan=evidence.span;evidence.quote=text
  const group=makeGroup(claim.id,[evidence.id]),artifactId=`art_${randomUUID()}`,body=`# Port\n\n${claim.text}\n`
  writeFileSync(join(made.root,'report.md'),body)
  const applied=made.store.withTransaction({expectedRevision:1,requestId:randomUUID(),payloadHash:'seed',applyFn(s){
    s.claims.push(claim);s.sources.push(source);s.evidence.push(evidence);s.groups.push(group)
    s.searches.push({id:`search_${randomUUID()}`,entityVersion:1,createdAt:'',updatedAt:'',purpose:'counterevidence',targetIds:[claim.id],corpus:[source.id],
      query:'port remained open?',tool:'read',performedAt:'2026-10-17T00:00:00.000Z',state:'executed',resultSourceIds:[source.id],inaccessible:[],finding:'none-found',executionEventRef:'read:archive'})
    s.artifacts.push({id:artifactId,entityVersion:1,createdAt:'',updatedAt:'',path:'report.md',contentHash:sha256Hex(body),outline:[],
      occurrences:[{claimId:claim.id,span:{start:8,end:8+claim.text.length},exactText:claim.text}]})
    return {result:{}}
  }});if(!applied.ok)throw new Error(applied.message)
  const head=made.store.readHead();if(!head.ok)throw new Error(head.message)
  const adapter=fakeAdapter([req=>{
    const env=JSON.parse(req.messages[1]!.content)
    let response:unknown
    if(env.stage==='extract'){
      response={items:[{span:{start:8,end:8+claim.text.length},exactText:claim.text,isQuotation:false,
        atomicClaims:[{text:claim.text,kind:'fact',scope:claim.scope,importance:'core'}]}]}
    }else{
      response={stage:env.stage,rubricVersion:'humanities-v1',findings:[],
        targets:(env.targets??[{id:artifactId}]).map((t:{id:string})=>({targetId:t.id,
          checks:env.requiredRules.filter((r:{targetId:string})=>r.targetId===t.id).map((r:{ruleId:string})=>({ruleId:r.ruleId,result:'pass',rationale:'the supplied material suffices',evidenceIds:[]})),
          ...(env.stage==='support'?{support:'direct',adequacy:'adequate',evidenceRelations:env.dependencies.evidence.map((e:{id:string})=>({evidenceId:e.id,support:'direct',rationale:'direct'}))}:{}),
          ...(env.stage==='claims'?{searchSufficiency:'checked'}:{})})),
        ...(env.stage==='align'?{alignment:env.items.map((i:{extractedId:string})=>({extractedId:i.extractedId,claimIds:[claim.id],relation:'exact',rationale:'same claim'}))}:{})}
    }
    return {raw:JSON.stringify(response),inputTokens:100,outputTokens:50}
  }])
  const run=()=>executeReviewRun({deps:{root:made.root,adapter,budget:BUDGET,contractHash:sha256Hex(stableJson(head.data.snapshot.contract)),
    readSnapshot:id=>readFileSync(join(made.store.snapshotDir,`${id}.md`),'utf8')},runId:`run_${randomUUID()}`,requestId:randomUUID(),
    snapshot:head.data.snapshot,targetClaimIds:[claim.id],stages:['sources','support','claims','arguments','audit'],signal:new AbortController().signal,
    artifact:{id:artifactId,path:'report.md',text:body}})
  return {...made,claim,source,artifactId,body,snapshot:head.data.snapshot,adapter,run}
}

describe('delivery hard conditions',()=>{
  it('full all review reaches a hash-bound report and a successfully read-back v2 reviewed receipt',async()=>{
    const f=fixture(),run=await f.run();expect(run.status).toBe('completed')
    const service=new VwaArgumentService({root:f.root}),frozen=await service.checkForDelivery(f.projectId,f.artifactId)
    expect(frozen.check.checks).toEqual({mechanical:'pass',evidence:'pass',argument:'pass',audit:'pass'})
    expect(frozen.check.eligibleForReviewed).toBe(true)
    const report=await service.renderReport(f.projectId,f.artifactId,frozen.evaluationId,'markdown')
    expect(report.text).toContain(f.claim.text);expect(report.text).toContain('Experimental')
    expect(report.reportHash).toBe(sha256Hex(report.text))
    const row=buildReceiptV2({sessionId:'session',ts:1,receiptId:`rec_${randomUUID()}`,projectId:f.projectId,artifactPath:join(f.root,'report.md'),
      events:[],workspaceRoot:f.root,parentHash:'',report:{path:'review.md',hash:report.reportHash},check:frozen.check,neverRun:false})
    expect(row.overall).toBe('pass');expect(row.delivery).toBe('reviewed')
    expect((await writeReceiptV2(join(f.root,'receipt.jsonl'),row)).ok).toBe(true)
  })
  it('a partial sources-only review cannot imply complete evidence or argument review',async()=>{
    const f=fixture(),run=await f.run();expect(run.status).toBe('completed')
    const store=new ReviewRunStore(f.root,f.projectId)
    // A separate project using only source records cannot satisfy the whole task plan.
    const records=store.readRecords(run.runId).filter(r=>r.stage==='sources')
    const {evaluateDelivery}=await import('../src/delivery-check.ts')
    const check=evaluateDelivery({root:f.root,snapshot:f.snapshot,text:f.body,artifactId:f.artifactId,records,pendingRunIds:[],adjudications:[],
      gates:[{gate:'link',status:'pass'},{gate:'exec',status:'pass',fenceCount:1}]})
    expect(check.checks.evidence).toBe('not-run');expect(check.eligibleForReviewed).toBe(false)
  })
  it('snapshot tampering is detected before any model dispatch and blocks delivery',async()=>{
    const f=fixture();writeFileSync(join(f.root,f.source.snapshotPath),'forged source')
    const result=await f.run();expect(result.status).toBe('incomplete');expect(f.adapter.state.dispatches).toBe(0)
    const frozen=await new VwaArgumentService({root:f.root}).checkForDelivery(f.projectId,f.artifactId)
    expect(frozen.check.checks.mechanical).toBe('fail');expect(frozen.check.eligibleForReviewed).toBe(false)
  })
  it('a model repair retry is refused when only one call was budgeted',async()=>{
    const f=fixture(),adapter=fakeAdapter([()=>({raw:'not JSON'})])
    const result=await executeReviewRun({deps:{root:f.root,adapter,budget:{...BUDGET,maxCallsPerRun:1},contractHash:''},runId:`run_${randomUUID()}`,
      requestId:randomUUID(),snapshot:f.snapshot,targetClaimIds:[f.claim.id],stages:['claims'],signal:new AbortController().signal})
    expect(result.status).toBe('budget-exhausted');expect(result.calls).toBe(1);expect(adapter.state.dispatches).toBe(1)
  })
  it('argument.report is an enabled public tool and generates reports without model calls',async()=>{
    const f=fixture();await f.run();const tools=new Map<string,any>()
    registerArgumentTools({tools:{register:t=>tools.set(t.name,t)}},{workspaceRoot:()=>f.root,captures:()=>({} as never),artifactTexts:new Map(),snapshotTexts:new Map(),maxEntities:10000})
    expect(tools.has('argument.report')).toBe(true)
    const before=f.adapter.state.dispatches
    const result=await tools.get('argument.report').execute({projectId:f.projectId,artifactId:f.artifactId,format:'markdown',write:true},{signal:new AbortController().signal})
    expect(result.ok).toBe(true);expect(readFileSync(join(f.root,result.data.path),'utf8')).toContain(f.claim.text)
    expect(f.adapter.state.dispatches).toBe(before)
  })
  it('a strict align response must include all AUDIT-01 through AUDIT-05 checks',async()=>{
    const f=fixture()
    const adapter=fakeAdapter([req=>{
      const env=JSON.parse(req.messages[1]!.content)
      return {raw:env.stage==='extract'?JSON.stringify({items:[]}):JSON.stringify({stage:'align',rubricVersion:'humanities-v1',targets:[],findings:[],alignment:[]})}
    }])
    const outcome=await executeReviewRun({deps:{root:f.root,adapter,budget:BUDGET,contractHash:''},runId:`run_${randomUUID()}`,requestId:randomUUID(),snapshot:f.snapshot,
      targetClaimIds:[f.claim.id],stages:['audit'],artifact:{id:f.artifactId,path:'report.md',text:f.body},signal:new AbortController().signal})
    expect(outcome.status).toBe('incomplete');expect(outcome.records.some(r=>r.errorCode==='REVIEW_INVALID')).toBe(true)
  })
})
