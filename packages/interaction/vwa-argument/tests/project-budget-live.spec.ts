import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { freezeReviewSettings } from '../src/review-config.ts'
import { makeWorkspace, CONTRACT } from './helpers.ts'
import { fakeAdapter, makeClaim, claimsResponse, BUDGET } from './review-helpers.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { reviseFrozenSettings, afterRevisionCommit } from '../src/review-settings-revision.ts'
import { semanticContractHash } from '../src/review-contract.ts'
import { projectUsage } from '../src/review-cycle.ts'
it.each((['maxCalls', 'maxInputTokens', 'maxOutputTokens'] as const).flatMap((dimension) => (['lower', 'add', 'raise'] as const).map((mode) => ({ dimension, mode }))))('uses current project ceiling during a running review: %j', async({dimension,mode})=>{
  const {root,projectId,store}=makeWorkspace()
  const initialLimit = dimension === 'maxCalls' ? 1 : dimension === 'maxInputTokens' ? 10 : 3000
  const initialSettings={...freezeReviewSettings(),budget:{...BUDGET,concurrency:1},...(mode === 'add' ? {} : {projectBudget:{[dimension]:mode === 'raise' ? initialLimit : 100_000}})}
  expect(store.init({...CONTRACT,reviewSettings:initialSettings}).ok).toBe(true)
  const claims=[makeClaim(),makeClaim()]
  const added=store.withTransaction({expectedRevision:1,requestId:'add',payloadHash:'add',applyFn:snapshot=>{snapshot.claims.push(...claims);return {result:null}}})
  expect(added.ok).toBe(true)
  const loaded=store.readHead();if(!loaded.ok)throw Error(loaded.message)
  const snapshot=loaded.data.snapshot
  const adapter=fakeAdapter([
    ()=>{
      const changed=store.withTransaction({expectedRevision:2,requestId:'lower',payloadHash:'lower',applyFn:snapshot=>{
        const revised=reviseFrozenSettings(snapshot.contract,{projectBudget:{[dimension]:mode === 'raise' ? 100_000 : 1}})
        snapshot.contract=revised.contract
        return {result:revised.revision}
      }})
      expect(changed.ok).toBe(true)
      afterRevisionCommit(root,projectId,'set-review-settings',changed)
      return {raw:claimsResponse(claims[0].id,'pass'),inputTokens:1,outputTokens:1}
    },
    ()=>({raw:claimsResponse(claims[1].id,'pass'),inputTokens:1,outputTokens:1})
  ])
  adapter.countInput = async () => ({ tokens: 10, method: 'tokenizer' })
  const result=await executeReviewRun({deps:{root,adapter,budget:initialSettings.budget,projectBudget:initialSettings.projectBudget,contractHash:semanticContractHash(snapshot.contract)},runId:'run_live',requestId:'live',stages:['claims'],targetClaimIds:claims.map(c=>c.id),snapshot,signal:new AbortController().signal})
  const live=store.readHead();if(!live.ok)throw Error(live.message)
  expect(live.data.snapshot.contract.reviewSettings?.projectBudget?.[dimension]).toBe(mode === 'raise' ? 100_000 : 1)
  expect(adapter.state.dispatches).toBe(mode === 'raise' ? 2 : 1)
  expect(result.status).toBe(mode === 'raise' ? 'completed' : 'budget-exhausted')
  if (mode !== 'raise') expect(result.refusal?.code).toBe('PROJECT_BUDGET_EXHAUSTED')
  expect(projectUsage(root,projectId).calls).toBe(mode === 'raise' ? 2 : 1)
})


it.each(['invalid-head', 'missing-head', 'invalid-revision'] as const)('fails closed before dispatch when real HEAD becomes %s', async (corruption) => {
  const { root, projectId, store } = makeWorkspace()
  const settings = { ...freezeReviewSettings(), budget: { ...BUDGET, concurrency: 1 } }
  expect(store.init({ ...CONTRACT, reviewSettings: settings }).ok).toBe(true)
  const claim = makeClaim()
  expect(store.withTransaction({ expectedRevision: 1, requestId: 'add', payloadHash: 'add', applyFn: (snapshot) => {
    snapshot.claims.push(claim)
    return { result: null }
  } }).ok).toBe(true)
  const head = store.readHead()
  if (!head.ok) throw Error(head.message)
  const adapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'pass'), inputTokens: 1, outputTokens: 1 })])
  adapter.initialize = async () => {
    const headPath = join(store.dir, 'HEAD.json')
    if (corruption === 'missing-head') unlinkSync(headPath)
    else if (corruption === 'invalid-head') writeFileSync(headPath, '{broken')
    else writeFileSync(join(store.dir, JSON.parse(readFileSync(headPath, 'utf8')).revisionPath), '{broken')
  }
  const result = await executeReviewRun({ deps: { root, adapter, budget: settings.budget, contractHash: semanticContractHash(head.data.snapshot.contract) }, runId: 'run_corrupt', requestId: 'corrupt', stages: ['claims'], targetClaimIds: [claim.id], snapshot: head.data.snapshot, signal: new AbortController().signal })
  expect(result.status).toBe('incomplete')
  expect(result.refusal?.code).toBe('STORE_CORRUPT')
  expect(adapter.state.dispatches).toBe(0)
  expect(projectUsage(root, projectId).calls).toBe(0)
})
