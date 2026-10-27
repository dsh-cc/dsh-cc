// Shared real-toolchain setup for the Lean integration specs: an already
// provisioned installation (FORMAL_DESIGN_LEAN_ROOT) or a test root built from
// the locally installed pinned toolchain. FORMAL_DESIGN_LEAN_CI=1 turns a missing
// toolchain into a failure instead of a skip.
import { existsSync } from 'node:fs'
import { cp, link, mkdir, mkdtemp, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentDigest, loadToolchain } from '../../skills/formal-design/scripts/lean-fingerprint.lib.mjs'

export const LOCAL_TOOLCHAIN = '/Users/bytedance/.elan/toolchains/leanprover--lean4---v4.35.0'
export const REQUIRED_IN_CI = process.env.FORMAL_DESIGN_LEAN_CI === '1'
export const PROVIDED_ROOT = process.env.FORMAL_DESIGN_LEAN_ROOT
export const DISCOVERED = PROVIDED_ROOT ?? (existsSync(join(LOCAL_TOOLCHAIN, 'bin/lean')) ? LOCAL_TOOLCHAIN : null)
/** `describe.skip` guard for a suite that needs the pinned toolchain. */
export const TOOLCHAIN_AVAILABLE = DISCOVERED !== null

// Hard links (or copies) of exactly the directories the installation content
// digest enumerates, so the tree can be hashed and the binary still runs. Never
// committed: the test root lives in the platform temporary directory.
async function linkTree(source: string, target: string) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isSymbolicLink()) { await symlink(await readlink(from), to); continue }
    if (entry.isDirectory()) { await linkTree(from, to); continue }
    try { await link(from, to) } catch { await cp(from, to) }
  }
}

export async function provisionTestRoot(scratch: string) {
  const destination = join(scratch, 'lean-4.35.0')
  for (const name of ['bin', 'lib']) await linkTree(join(LOCAL_TOOLCHAIN, name), join(destination, name))
  const pin = await loadToolchain()
  const platform = process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64'
  await writeFile(`${destination}.receipt.json`, JSON.stringify({
    schemaVersion: 1, toolchain: pin.toolchain, archiveSha256: pin.platforms[platform].sha256, contentDigest: await contentDigest(destination),
  }))
  return destination
}

/** Resolve the Lean root for a spec: the provided one, a provisioned test root, or null. */
export async function resolveLeanRoot(scratch: string): Promise<string | null> {
  if (PROVIDED_ROOT) return await realpath(PROVIDED_ROOT)
  if (DISCOVERED) return await provisionTestRoot(scratch)
  return null
}
