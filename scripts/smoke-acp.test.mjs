#!/usr/bin/env node
/**
 * smoke-acp.test.mjs — self-running spec for the pure floor-construction
 * helpers of smoke-acp.mjs (plain node + assert, check-publish-manifests
 * idiom). The full smoke needs a real built dsh — it is NOT run here.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_APP_PIN, ACP_BUNDLES } from "../packages/launcher/tui/bootstrap.mjs";
import { floorDependencies, pkgDir, preflightErrors } from "./smoke-acp.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Floor mirrors the launcher's ACP bundle list.
const deps = floorDependencies(repoRoot);
assert.deepEqual(Object.keys(deps), ["@deepseek-ai/dsh-acp-app", "@dsh-cc/bundle-permissions", "@dsh-cc/bundle-shell", "@dsh-cc/bundle-acp"]);
assert.equal(deps["@deepseek-ai/dsh-acp-app"], ACP_APP_PIN);
for (const name of Object.keys(deps)) {
  if (!name.startsWith("@dsh-cc/")) continue;
  assert.ok(deps[name].startsWith("link:"), `${name} must link into this worktree`);
  assert.ok(existsSync(deps[name].slice(5)), `${deps[name]} exists`);
  assert.ok(existsSync(join(deps[name].slice(5), "cordis.patch.yml")), `${name} carries its bundle patch`);
}
// dsh-base must never become a profile dependency.
assert.ok(!("@deepseek-ai/dsh-base" in deps));
assert.ok(pkgDir(repoRoot, "@dsh-cc/bundle-acp").endsWith("packages/bundle/cc-acp"));

// Preflight reports problems, not throws, on a missing harness build.
const { problems, cli } = preflightErrors(repoRoot, join(repoRoot, "does", "not", "exist"));
assert.equal(cli, join(repoRoot, "does", "not", "exist", "apps", "cli", "lib", "bin.js"));
assert.ok(problems.some((p) => p.includes("build:lib")), "missing harness surfaces a build hint");
if (existsSync(join(repoRoot, "packages/acp/cc-acp/lib"))) {
  assert.equal(preflightErrors(repoRoot).problems.length, 0, "built worktree prefights clean");
} else {
  assert.ok(preflightErrors(repoRoot).problems.some((p) => p.includes("pnpm run build")));
}
console.log("smoke-acp.test.mjs: OK");
