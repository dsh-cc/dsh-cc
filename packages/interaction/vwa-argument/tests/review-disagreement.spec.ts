import {describe,it,expect} from 'vitest'
import {digestRecords} from '../src/policy.ts'
import {makeClaim,claimsResponse} from './review-helpers.ts'
import type {ReviewRecord} from '../src/types.ts'

describe('same-input conflicting judgments preserve the original negative check',()=>{
  it('a pass cannot overwrite a fail in either record order',()=>{
    const c=makeClaim()
    const record=(result:'pass'|'fail')=>({stage:'claims',status:'completed',response:JSON.parse(claimsResponse(c.id,result))} as ReviewRecord)
    for(const records of [[record('fail'),record('pass')],[record('pass'),record('fail')]]){
      expect(digestRecords(records).claims.get(c.id)?.checks[0]?.result).toBe('fail')
    }
  })
})
