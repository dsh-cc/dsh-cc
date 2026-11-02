/**
 * Two-process lock contention probe (issue #307 §5 case 11): takes the real
 * lock on the given dir, holds it past the 2 s wait, then releases. Exits 0
 * when it acquired and 1 with LOCK_BUSY on stdout when it did not.
 */
import { acquireLock, releaseLock } from '../../src/lock.ts'

const dir = process.argv[2]!
const refusal = acquireLock(dir)
if (refusal !== undefined) {
  console.log(refusal.code)
  process.exit(1)
}
setTimeout(() => {
  releaseLock(dir)
  process.exit(0)
}, 2500)
