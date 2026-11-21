import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fresh real-tmp workspace per test; returned registrar collects cleanup paths. */
export function workspaces() {
  const paths: string[] = []
  return {
    async make(prefix: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      paths.push(dir)
      return dir
    },
    async cleanup(): Promise<void> {
      await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
    },
  }
}

/** Capture stdout while running an async function (scripts print single-line JSON). */
export async function captureStdout<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  let text = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: unknown) => { text += String(chunk); return true }) as typeof process.stdout.write
  try {
    return { value: await fn(), text }
  } finally {
    process.stdout.write = original
  }
}

/** Run a script main() and parse its last stdout line as JSON. */
export async function cli(main: (argv: string[], deps?: unknown) => Promise<number>, argv: string[], deps?: unknown) {
  const { value, text } = await captureStdout(() => main(argv, deps))
  const lines = text.trim().split('\n').filter(Boolean)
  return { exitCode: value, output: JSON.parse(lines.at(-1)!) as Record<string, unknown>, raw: text }
}

export const isoNow = () => new Date().toISOString()
export const HEX = (char: string) => char.repeat(64)
