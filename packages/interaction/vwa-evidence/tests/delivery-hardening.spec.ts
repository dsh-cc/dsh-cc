import { describe,it,expect } from 'vitest'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {deliveryState,overallOf} from '../src/vwa-delivery.ts'
import {sha256Hex} from '../src/receipt.ts'

describe('delivery requires both exact presented paths and current bytes',()=>{
  function fixture(){
    const root=mkdtempSync(join(tmpdir(),'vwa-present-'))
    writeFileSync(join(root,'body.md'),'body');writeFileSync(join(root,'review.md'),'review');writeFileSync(join(root,'copy.md'),'body')
    return {workspaceRoot:root,artifactPath:join(root,'body.md'),artifactHash:sha256Hex('body'),reportPath:'review.md',reportHash:sha256Hex('review'),eligibleForReviewed:true}
  }
  const event=(paths:string[])=>[{type:'deliverables/presented',data:{files:paths.map(path=>({path}))}}]
  it('body alone cannot claim delivered-reviewed',()=>{
    const f=fixture();expect(deliveryState({...f,events:event(['body.md'])})).toBe('reviewed')
  })
  it('report alone cannot claim delivered-reviewed',()=>{
    const f=fixture();expect(deliveryState({...f,events:event(['review.md'])})).toBe('reviewed')
  })
  it('a byte-identical copy at another path is not presentation of the artifact',()=>{
    const f=fixture();expect(deliveryState({...f,events:event(['copy.md','review.md'])})).toBe('reviewed')
  })
  it('both absolute presented paths with matching bytes advance delivery',()=>{
    const f=fixture();expect(deliveryState({...f,events:event([f.artifactPath,join(f.workspaceRoot,'review.md')])})).toBe('delivered-reviewed')
  })
  it('pending reviews always abstain, including when an older review failed',()=>{
    expect(overallOf({pendingRunIds:['run_pending'],checks:{mechanical:'pass',evidence:'fail',argument:'pass',audit:'pass'},findingCounts:{blocker:0,major:1,minor:0},eligibleForReviewed:false} as never,false)).toBe('abstained')
  })
})
