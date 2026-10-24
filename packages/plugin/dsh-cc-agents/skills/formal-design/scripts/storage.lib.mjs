import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, basename } from 'node:path'
import { parseJson, object } from './manifest.lib.mjs'
export async function probeLock(path, kill = process.kill) {
  let value
  try {
    value = parseJson(await fs.readFile(path, 'utf8'))
    object(value, ['schemaVersion', 'pid', 'runId', 'startedAt'])
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.runId !== 'string' || !value.runId || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) throw new Error('invalid lock')
  } catch (e) { if (e.code === 'ENOENT') return { state: 'missing' }; return { state: 'indeterminate', detail: 'lock malformed or unreadable; ownership unknown' } }
  let state
  try { kill(value.pid, 0); state = 'present' } catch (e) { state = e.code === 'ESRCH' ? 'absent' : 'indeterminate' }
  return { state, value, detail: `lock PID ${state}; recorded pid=${value.pid}, runId=${value.runId}, startedAt=${value.startedAt}; PID presence does not establish checker identity` }
}
export const temporary = path => `${dirname(path)}/.${basename(path)}.${randomUUID()}.tmp`
export async function stageJson(path, value, io = fs) {
  const temp = temporary(path)
  let handle
  try { handle = await io.open(temp, 'wx'); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; return temp }
  catch (e) { if (handle) await handle.close().catch(() => {}); await io.unlink(temp).catch(() => {}); throw e }
}
export async function atomicJson(path, value, io = fs) {
  const temp = await stageJson(path, value, io)
  try { await io.rename(temp, path) } catch (e) { await io.unlink(temp).catch(() => {}); throw e }
}
