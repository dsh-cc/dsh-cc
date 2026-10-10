#!/usr/bin/env node
/**
 * smoke-acp.mjs — PR-B gate (docs/plans/2026-10-09-acp-m2-own-plugin.md §6):
 * drive the exact production ACP floor (`dsh --profile cc-acp`) in a scratch
 * DSH_HOME over NDJSON and assert the composed mount end to end:
 *   1. initialize answers with agentInfo.name 'dsh-cc' (branding),
 *   2. session/prompt settles end_turn,
 *   3. the persisted session HEADER carries agentPreset: 'cc' — proving the
 *      create-path bundle mount composed without Host-activation deadlock,
 *      hmr off, single tool plane (transitively: the prompt ran).
 *
 * Plain node, no new deps. The zstd transcript is decompressed via the `zstd`
 * CLI (same convention as scripts/audit-subagent-children.mjs).
 *
 * `--dry-run` validates preflight + floor construction without spawning dsh.
 * The profile floor mirrors packages/launcher/tui/bootstrap.mjs ACP_BUNDLES,
 * with the unpublished @dsh-cc bundles pointed at this worktree via link:.
 *
 * Usage: pnpm smoke:acp [--dry-run]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_APP_PIN, ACP_BUNDLES, ACP_PROFILE } from "../packages/launcher/tui/bootstrap.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const dryRun = process.argv.includes("--dry-run");
// Optional full mode: `--overlay <file>` copies a provider overlay into the
// floor's cordis.patch.yml (a real model route) and enables the prompt leg;
// `--credentials-link` symlinks ~/.dsh/.credentials.yaml into the scratch
// home. Without an overlay the smoke runs reduced: initialize + session/new
// + header stamp (no model route to drive a turn).
const overlayIdx = process.argv.indexOf("--overlay");
const overlayPath = overlayIdx >= 0 ? process.argv[overlayIdx + 1] : undefined;
const credentialsLink = process.argv.includes("--credentials-link");
// Full mode additionally keys the acp-cc row's model route from the shell env
// (same DSH_CC_PROVIDER/DSH_CC_MODEL contract the launcher's bundle patch
// documents); the roster persona interpolates {{model}}, so a prompt without
// a resolved route fails assembly.
const overlayRoute =
  overlayPath === undefined
    ? undefined
    : { provider: process.env.DSH_CC_PROVIDER, model: process.env.DSH_CC_MODEL };
if (overlayRoute !== undefined && (!overlayRoute.provider || !overlayRoute.model)) {
  console.error("full mode needs DSH_CC_PROVIDER + DSH_CC_MODEL (the acp-cc row's model route)");
  process.exit(2);
}

/** Repo dir of an @dsh-cc/bundle-* package name, e.g. @dsh-cc/bundle-acp → packages/bundle/acp. */
export function pkgDir(repoRoot, name) {
  const short = name.slice("@dsh-cc/".length);
  if (!short.startsWith("bundle-")) throw new Error(`no repo-dir mapping for ${name}`);
  return join(repoRoot, "packages", "bundle", `cc-${short.slice("bundle-".length)}`);
}

/** Profile-floor dependencies: pinned acp-app + link: into this worktree.
 *
 * Harness-owned runtime packages (the preset registry/declaration, the
 * include loader — anything sharing dsh-scope's module-global kScope Symbol)
 * must NOT become floor dependencies. A floor copy coexists with the ambient
 * dsh installation's copy, and module-global state splits by realpath: the
 * roster's standing scope gets tagged by whichever copy the registry row
 * resolves to, while dsh-system-prompt's ScopedLayers reads another — the tag
 * becomes invisible, scoped registrations fall onto the global layer and
 * collide ('deployment:persona-prefix' etc.; live-verified 2026-10-10, see
 * the PR-B commit chain for the full root-cause ledger). All harness packages
 * must resolve from ONE tree — for this smoke, the ambient dsh build.
 *
 * pnpm does NOT materialize the dependency closure of a link: target — only
 * the content anchor the include row reads by floor-relative path
 * (node_modules/@dsh-cc/preset-cc/agent.cordis.yml) needs an explicit entry,
 * and preset-cc is dsh-cc-owned so a link: copy is module-identity-safe.
 */
export function floorDependencies(repoRoot) {
  const deps = {};
  for (const name of ACP_BUNDLES) {
    if (name === "@deepseek-ai/dsh-base") continue; // resolves from the dsh installation, never a profile dep
    if (name === "@deepseek-ai/dsh-acp-app") deps[name] = ACP_APP_PIN;
    else deps[name] = `link:${pkgDir(repoRoot, name)}`;
  }
  // link: closure proxy for the published bundle's @dsh-cc/preset-cc dep (the
  // include row reads the file by floor-relative path; module-identity-safe).
  deps["@dsh-cc/preset-cc"] = `link:${join(repoRoot, "packages", "preset", "cc")}`;
  return deps;
}

/** Clear preflight failures: harness CLI built, local lib/ built, zstd present. */
export function preflightErrors(repoRoot, harness = process.env.DSH_HARNESS_DIR ?? join(repoRoot, "..", "deepseek-harness")) {
  const problems = [];
  const cli = join(harness, "apps", "cli", "lib", "bin.js");
  if (!existsSync(cli)) {
    problems.push(`harness CLI not built: ${cli} — run: npm --prefix ${harness} run build:lib (or set DSH_HARNESS_DIR)`);
  }
  for (const name of ACP_BUNDLES) {
    if (!name.startsWith("@dsh-cc/")) continue;
    const dir = pkgDir(repoRoot, name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.main?.startsWith("lib/") && !existsSync(join(dir, "lib"))) {
      problems.push(`${name} has no lib/ — run: pnpm run build`);
    }
  }
  return { cli, problems };
}

const failures = [];
const fail = (msg) => failures.push(msg);

const { cli, problems } = preflightErrors(repoRoot);
for (const p of problems) fail(p);
if (spawnSync("zstd", ["--version"]).status !== 0) {
  fail("the `zstd` CLI is required (session transcript) — install zstd, e.g. `brew install zstd`");
}

// Floor construction (identical in both modes).
const home = mkdtempSync(join(tmpdir(), "dsh-smoke-acp-home."));
const projDir = join(home, "project");
const floorDir = join(home, "profiles", ACP_PROFILE);
mkdirSync(projDir, { recursive: true });
mkdirSync(floorDir, { recursive: true });
const floor = {
  name: `dsh-profile-${ACP_PROFILE}-smoke`,
  private: true,
  dependencies: floorDependencies(repoRoot),
  dsh: { profile: { bundles: [...ACP_BUNDLES] } },
};
writeFileSync(join(floorDir, "package.json"), JSON.stringify(floor, null, 2) + "\n");
if (overlayPath !== undefined) {
  // Full mode: provider overlay becomes the floor's user-layer patch, plus the
  // acp-cc row's model route keyed from DSH_CC_PROVIDER/DSH_CC_MODEL.
  const route = `\n# smoke-full model route (from DSH_CC_PROVIDER/DSH_CC_MODEL env)\n- id: acp-cc\n  config:\n    provider: !!js '${JSON.stringify(overlayRoute.provider)}'\n    model: !!js '${JSON.stringify(overlayRoute.model)}'\n`;
  copyFileSync(overlayPath, join(floorDir, "cordis.patch.yml"));
  const appended = readFileSync(join(floorDir, "cordis.patch.yml"), "utf8") + route;
  writeFileSync(join(floorDir, "cordis.patch.yml"), appended);
}
if (credentialsLink) {
  symlinkSync(join(process.env.HOME ?? "/dev/null", ".dsh", ".credentials.yaml"), join(home, ".credentials.yaml"));
}

console.log(`smoke:acp floor (${ACP_PROFILE}):\n${JSON.stringify(floor, null, 2)}`);
if (problems.length > 0 || dryRun) {
  rmSync(home, { recursive: true, force: true });
  for (const f of failures) console.error(`FAIL: ${f}`);
  if (problems.length > 0) process.exit(1);
  console.log("smoke:acp --dry-run: floor construction + wiring OK (dsh not spawned)");
  process.exit(0);
}

// Install the floor with pnpm inside the scratch home.
const install = spawnSync("pnpm", ["install", "--store-dir", join(home, "pnpm-store")], {
  cwd: floorDir,
  encoding: "utf8",
});
if (install.status !== 0) {
  console.error(`pnpm install failed in ${floorDir}:\n${install.stdout}\n${install.stderr}`);
  process.exit(1);
}

// NDJSON driver (probe-client shape).
const stderrLog = join(home, "dsh-stderr.log");
const child = spawn(process.execPath, [cli, "--profile", ACP_PROFILE], {
  cwd: projDir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => writeFileSync(stderrLog, d, { flag: "a" }));

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const p = msg.id !== undefined && pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  }
});
const request = (method, params, timeoutMs) =>
  new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, error: { message: `timeout after ${timeoutMs}ms` }, probeTimeout: true });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

let sessionId;
try {
  const init = await request(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "dsh-cc-smoke-acp", version: "0.0.0" },
    },
    240_000,
  );
  const name = init.result?.agentInfo?.name;
  if (name !== "dsh-cc") fail(`initialize agentInfo.name expected 'dsh-cc', got ${JSON.stringify(name)}`);

  const created = await request("session/new", { cwd: projDir, mcpServers: [] }, 120_000);
  if (created.error) fail(`session/new: ${created.error.message}`);
  else sessionId = created.result?.sessionId;

  if (sessionId) {
    // Header stamp first (reduced mode asserts up to here): find the persisted
    // transcript for this session id.
    let headerLine;
    const sessionsRoot = join(home, "sessions");
    outer: for (const projectKey of existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []) {
      for (const f of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
        const file = join(sessionsRoot, projectKey, sessionId, f);
        if (!existsSync(file)) continue;
        headerLine = execFileSync("zstd", ["-dc", file], { maxBuffer: 64 * 1024 * 1024 })
          .toString("utf8")
          .split("\n", 1)[0];
        break outer;
      }
    }
    let header;
    try {
      header = JSON.parse(headerLine);
    } catch {
      fail(`no transcript header found for session ${sessionId} under ${sessionsRoot}`);
    }
    if (header && header.agentPreset !== "cc")
      fail(`session header agentPreset expected 'cc', got ${JSON.stringify(header.agentPreset)}`);

    if (overlayPath === undefined) {
      console.log("smoke:acp reduced mode (no --overlay): skipping the prompt leg — no model route");
    } else {
      const prompt = await request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: "Reply with exactly: PONG" }] },
        180_000,
      );
      if (prompt.error) fail(`session/prompt: ${prompt.error.message}`);
      else if (prompt.result?.stopReason !== "end_turn")
        fail(`prompt stopReason expected 'end_turn', got ${JSON.stringify(prompt.result?.stopReason)}`);
    }
  }
} catch (e) {
  fail(e.message);
} finally {
  child.kill("SIGKILL");
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  console.error(`stderr log: ${stderrLog}; scratch home kept: ${home}`);
  process.exit(1);
}
rmSync(home, { recursive: true, force: true });
console.log(
  `smoke:acp OK (${overlayPath === undefined ? "reduced" : "full"}) — dsh-cc branding, agentPreset 'cc' header stamp${overlayPath === undefined ? "" : ", end_turn prompt"}`,
);
