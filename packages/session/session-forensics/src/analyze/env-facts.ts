/**
 * Analyzer 2 — environment facts. Same first-token command failing, then a
 * different invocation with that first token succeeding: record the working
 * incantation. Error signatures are normalized result text, not prose parsing.
 */
import type { Finding, ToolRecord } from "../types.ts";
import { anchor } from "../types.ts";

function firstToken(record: ToolRecord): string | undefined {
  const command = (record.args as Record<string, unknown>)?.command;
  if (typeof command !== "string") return undefined;
  const token = command.split(/\s+/).find(Boolean);
  return token;
}

function errorSignature(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  // ponytail: naive signature — first non-empty error line. Good enough to
  // distinguish ModuleNotFoundError from exit codes; upgrade if noisy.
  return (line ?? text.slice(0, 120)).slice(0, 160);
}

export function findEnvFacts(records: ToolRecord[]): Finding[] {
  const findings: Finding[] = [];
  const bash = records.filter(
    (r) => r.name.toLowerCase() === "bash" && typeof (r.args as Record<string, unknown>)?.command === "string",
  );
  for (let i = 0; i < bash.length; i++) {
    const failure = bash[i]!;
    if (!failure.isError || failure.resultText === "") continue;
    const first = firstToken(failure);
    if (first === undefined) continue;
    const failureSig = errorSignature(failure.resultText);
    for (let j = i + 1; j < bash.length; j++) {
      const success = bash[j]!;
      if (success.isError || firstToken(success) !== first) continue;
      const successSig = errorSignature(success.resultText);
      if (successSig === failureSig) continue; // no distinct signature: nothing learned
      const failedCmd = (failure.args as Record<string, unknown>)
        .command as string;
      const goodCmd = (success.args as Record<string, unknown>)
        .command as string;
      findings.push({
        kind: "env-fact",
        title: `use \`${goodCmd}\` instead of plain \`${first}\``,
        detail: `\`${failedCmd}\` failed with "${failureSig}"; \`${goodCmd}\` succeeded.`,
        occurrences: 1,
        evidence: [anchor(failure.sessionId, failure.turn)],
      });
      break;
    }
  }
  return findings;
}
