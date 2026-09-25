#!/usr/bin/env node
/**
 * daily-release-decide.test.mjs — self-running harness (node:assert).
 * Inject clocks/tags; no network / no git.
 */
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  decide,
  weekStartYmd,
  sameSingaporeWeek,
  nextLineVersion,
  parseRc,
  parseVersion,
  cmpVersion,
  selectLine,
  assertMonotonic,
} = await import(pathToFileURL(join(__dirname, "daily-release-decide.mjs")).href);

let failures = 0;
function pass(name) {
  console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  console.error(`[FAIL] ${name}: ${detail}`);
  failures++;
}
function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (e) {
    fail(name, e.stack || e.message);
  }
}

const TZ = "Asia/Singapore";

/** Singapore-local instant helper: `2026-09-14` Monday 08:00 SGT. */
function sgt(ymd, hm = "08:00:00") {
  return new Date(`${ymd}T${hm}+08:00`);
}

const base = {
  timeZone: TZ,
  lastStable: "v0.7.1",
  bump: "auto",
  hasFeatSinceStable: true, // → line 0.8.0
  headAheadOfStable: true,
  headAheadOfLatestRc: false,
  latestRcOnLine: null,
  tags: [],
};

check("helper: weekStartYmd Monday stays Monday", () => {
  assert.equal(weekStartYmd(sgt("2026-09-14"), TZ), "2026-09-14");
});

check("helper: weekStartYmd Wednesday → prior Monday", () => {
  assert.equal(weekStartYmd(sgt("2026-09-16"), TZ), "2026-09-14");
});

check("helper: sameSingaporeWeek Mon–Fri same week", () => {
  assert.equal(sameSingaporeWeek(sgt("2026-09-14"), sgt("2026-09-18"), TZ), true);
  assert.equal(sameSingaporeWeek(sgt("2026-09-14"), sgt("2026-09-21"), TZ), false);
});

check("helper: nextLineVersion auto feat → minor", () => {
  assert.equal(nextLineVersion("v0.7.1", "auto", true), "0.8.0");
});

check("helper: nextLineVersion auto no-feat → patch", () => {
  assert.equal(nextLineVersion("v0.7.1", "auto", false), "0.7.2");
});

check("1. Monday, no week stable, no rc → x.y.z-rc.1", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-14"), // Monday
    tags: [
      { name: "v0.7.1", date: sgt("2026-09-07") }, // prior week stable
      { name: "v0.7.1-rc.3", date: sgt("2026-09-05") },
    ],
    latestRcOnLine: null,
    headAheadOfStable: true,
    hasFeatSinceStable: true,
  });
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.8.0-rc.1");
  assert.equal(r.reason, "first_rc");
});

check("2. After rc.N + new commits → rc.N+1", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-16"), // Wednesday
    tags: [
      { name: "v0.7.1", date: sgt("2026-09-07") },
      { name: "v0.8.0-rc.2", date: sgt("2026-09-15") },
    ],
    latestRcOnLine: "v0.8.0-rc.2",
    headAheadOfStable: true,
    headAheadOfLatestRc: true,
    hasFeatSinceStable: true,
  });
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.8.0-rc.3");
  assert.equal(r.reason, "rc_bump");
});

check("3. After rc.N + no new commits → stable", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-17"), // Thursday
    tags: [
      { name: "v0.7.1", date: sgt("2026-09-07") },
      { name: "v0.8.0-rc.3", date: sgt("2026-09-16") },
    ],
    latestRcOnLine: "v0.8.0-rc.3",
    headAheadOfStable: true,
    headAheadOfLatestRc: false,
    hasFeatSinceStable: true,
  });
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.8.0");
  assert.equal(r.reason, "stabilize");
});

check("4. Week already has stable → skip", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-16"),
    tags: [
      { name: "v0.7.1", date: sgt("2026-09-07") },
      { name: "v0.8.0", date: sgt("2026-09-15") }, // stable this week
    ],
    latestRcOnLine: "v0.8.0-rc.3",
    headAheadOfStable: true, // even if ahead, week gate wins
    headAheadOfLatestRc: true,
    hasFeatSinceStable: true,
  });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "week_has_stable");
  assert.equal(r.week_stable, "v0.8.0");
});

check("5. Latest tag is rc (9/15 shape) → does not throw; decides correctly", () => {
  // Gate used to pass LAST_TAG=v0.7.1-rc.3 (version-sorted) into a
  // stable-only calculator that threw. decide() takes lastStable separately
  // and treats the dangling rc as unrelated to the new line.
  const r = decide({
    ...base,
    now: sgt("2026-09-15"), // Monday of that week was 9/14; 9/15 is Tue
    tags: [
      { name: "v0.7.0", date: sgt("2026-08-20") },
      { name: "v0.7.1", date: sgt("2026-09-01") },
      { name: "v0.7.1-rc.1", date: sgt("2026-08-28") },
      { name: "v0.7.1-rc.2", date: sgt("2026-08-29") },
      { name: "v0.7.1-rc.3", date: sgt("2026-08-30") }, // highest v* by version sort
    ],
    lastStable: "v0.7.1",
    latestRcOnLine: null, // candidate line is 0.8.0; old 0.7.1-rc.* ignored
    headAheadOfStable: true,
    headAheadOfLatestRc: false,
    hasFeatSinceStable: true,
  });
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.8.0-rc.1");
  assert.equal(r.reason, "first_rc");
});

check("mid-week first run (Wed) with no rc yet → still rc.1", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-16"),
    tags: [{ name: "v0.7.1", date: sgt("2026-09-07") }],
    latestRcOnLine: null,
    headAheadOfStable: true,
    hasFeatSinceStable: false, // patch line
  });
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.7.2-rc.1");
});

check("no unreleased work → skip", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-16"),
    tags: [{ name: "v0.7.1", date: sgt("2026-09-07") }],
    headAheadOfStable: false,
  });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "no_unreleased_work");
});

check("rc on a different line is ignored → first_rc on new line", () => {
  const r = decide({
    ...base,
    now: sgt("2026-09-16"),
    tags: [
      { name: "v0.7.1", date: sgt("2026-09-07") },
      { name: "v0.7.2-rc.1", date: sgt("2026-09-15") },
    ],
    // Caller mistakenly passed an off-line rc; decide must ignore it.
    latestRcOnLine: "v0.7.2-rc.1",
    headAheadOfStable: true,
    headAheadOfLatestRc: true,
    hasFeatSinceStable: true, // line = 0.8.0
  });
  assert.equal(r.version, "0.8.0-rc.1");
  assert.equal(r.reason, "first_rc");
});

check("parseRc extracts line + n", () => {
  const p = parseRc("v0.8.0-rc.2");
  assert.equal(p.line, "0.8.0");
  assert.equal(p.n, 2);
});

/* ---- #144 regression: never propose an rc below npm `next` (plan §6.2/§6.6) ---- */

// Real tag set on main at 043787a (2026-09-25); npm: latest=0.7.1, next=0.8.1-rc.1.
const TAGS_144 = [
  { name: "v0.7.0", date: sgt("2026-08-20") },
  { name: "v0.7.1-rc.1", date: sgt("2026-08-28") },
  { name: "v0.7.1-rc.2", date: sgt("2026-08-29") },
  { name: "v0.7.1-rc.3", date: sgt("2026-08-30") },
  { name: "v0.7.1", date: sgt("2026-09-07") },
  { name: "v0.8.0-rc.1", date: sgt("2026-09-15") },
  { name: "v0.8.0-rc.2", date: sgt("2026-09-16") },
  { name: "v0.8.0-rc.3", date: sgt("2026-09-17") },
  { name: "v0.8.1-rc.1", date: sgt("2026-09-24") },
];
const MON_0928 = sgt("2026-09-28"); // next Monday cron

/** Mirror of gatherInputFromGit's rc lookup, on the selected line. */
function gatherLike(over) {
  const inp = { ...base, ...over };
  const line = selectLine(inp);
  let best = null;
  for (const t of inp.tags) {
    const p = parseRc(t.name);
    if (p && p.line === line && (!best || p.n > best.n)) best = { ...p, name: t.name };
  }
  return { ...inp, latestRcOnLine: best ? best.name : null };
}

check("selectLine: base 0.8.0 but v0.8.1-rc.1 tagged → 0.8.1", () => {
  assert.equal(selectLine({ lastStable: "v0.7.1", bump: "auto", hasFeatSinceStable: true, tags: TAGS_144 }), "0.8.1");
});

check("selectLine: rc tags at/below lastStable are ignored", () => {
  assert.equal(
    selectLine({
      lastStable: "v0.7.1",
      bump: "auto",
      hasFeatSinceStable: true,
      tags: [{ name: "v0.7.1-rc.3", date: sgt("2026-08-30") }],
      npmNext: "0.7.1",
    }),
    "0.8.0",
  );
});

check("selectLine: npm next line with no git tag wins over base", () => {
  assert.equal(
    selectLine({ lastStable: "v0.7.1", bump: "auto", hasFeatSinceStable: false, tags: [], npmNext: "0.8.1-rc.1" }),
    "0.8.1",
  );
});

check("#144 repro: latest=0.7.1 next=0.8.1-rc.1, tags ..v0.8.0-rc.3 + v0.8.1-rc.1, new commits → 0.8.1-rc.2", () => {
  const r = decide(
    gatherLike({
      now: MON_0928,
      tags: TAGS_144,
      headAheadOfStable: true,
      headAheadOfLatestRc: true,
      hasFeatSinceStable: true,
      npmNext: "0.8.1-rc.1",
    }),
  );
  assert.equal(r.action, "propose");
  assert.equal(r.version, "0.8.1-rc.2");
  assert.equal(r.reason, "rc_bump");
  assert.equal(r.line, "0.8.1");
});

check("#144 repro: stale caller latestRcOnLine=v0.8.0-rc.3 is ignored → 0.8.1-rc.2 (never 0.8.0-rc.4)", () => {
  const r = decide({
    ...base,
    now: MON_0928,
    tags: TAGS_144,
    latestRcOnLine: "v0.8.0-rc.3", // what the pre-fix gather passed
    headAheadOfStable: true,
    headAheadOfLatestRc: true,
    npmNext: "0.8.1-rc.1",
  });
  assert.equal(r.version, "0.8.1-rc.2");
});

check("#144 repro without npm (registry down) → still 0.8.1-rc.2 from git tags", () => {
  const r = decide(
    gatherLike({ now: MON_0928, tags: TAGS_144, headAheadOfLatestRc: true, npmNext: null }),
  );
  assert.equal(r.version, "0.8.1-rc.2");
});

check("#144 shape, no commits since v0.8.1-rc.1 → stabilize 0.8.1 (never 0.8.0*)", () => {
  const r = decide(
    gatherLike({ now: MON_0928, tags: TAGS_144, headAheadOfLatestRc: false, npmNext: "0.8.1-rc.1" }),
  );
  assert.equal(r.action, "propose");
  assert.equal(r.reason, "stabilize");
  assert.equal(r.version, "0.8.1");
});

check("next above stable's rc line with NO matching git tag → rc past next", () => {
  for (const hasFeatSinceStable of [true, false]) {
    const r = decide(
      gatherLike({
        now: MON_0928,
        tags: TAGS_144.filter((t) => t.name !== "v0.8.1-rc.1"),
        headAheadOfLatestRc: false, // no tag on 0.8.1 → gather reports false
        hasFeatSinceStable,
        npmNext: "0.8.1-rc.1",
      }),
    );
    assert.equal(r.action, "propose");
    assert.equal(r.line, "0.8.1", `hasFeat=${hasFeatSinceStable}`);
    assert.equal(r.version, "0.8.1-rc.2", `hasFeat=${hasFeatSinceStable}`);
  }
});

check("npm next ahead of the highest tag on the same line → skip past next", () => {
  const r = decide(
    gatherLike({
      now: MON_0928,
      tags: TAGS_144, // highest merged tag on 0.8.1 is rc.1
      headAheadOfLatestRc: false,
      npmNext: "0.8.1-rc.3", // rc.2/rc.3 published without a merged tag
    }),
  );
  assert.equal(r.version, "0.8.1-rc.4");
});

check("invalid npmNext throws", () => {
  assert.throws(() => decide({ ...base, now: MON_0928, npmNext: "latest" }), /invalid npmNext/);
});

check("assertMonotonic: 0.8.0-rc.4 vs v0.8.1-rc.1 tag → monotonic_violation", () => {
  assert.throws(() => assertMonotonic("0.8.0-rc.4", TAGS_144), /monotonic_violation: 0\.8\.0-rc\.4 <= v0\.8\.1-rc\.1/);
});

check("assertMonotonic: rc below npm next (no tags) → monotonic_violation", () => {
  assert.throws(() => assertMonotonic("0.8.0-rc.4", [], parseVersion("0.8.1-rc.1")), /monotonic_violation/);
  assertMonotonic("0.8.1-rc.2", TAGS_144, parseVersion("0.8.1-rc.1"));
  assertMonotonic("0.8.1", TAGS_144, parseVersion("0.8.1-rc.1")); // stable vs stable tags only
});

check("invariant: every proposed rc >= npm next and > every rc tag; stable > every stable tag", () => {
  const tagSets = [
    [],
    TAGS_144,
    TAGS_144.filter((t) => t.name !== "v0.8.1-rc.1"),
    TAGS_144.filter((t) => !t.name.startsWith("v0.8.0")),
  ];
  const nexts = [null, "0.7.1", "0.8.0-rc.3", "0.8.1-rc.1", "0.8.1-rc.5", "0.9.0-rc.1", "0.7.2-rc.1"];
  let n = 0;
  for (const tags of tagSets)
    for (const npmNext of nexts)
      for (const bump of ["auto", "patch", "minor"])
        for (const hasFeatSinceStable of [true, false])
          for (const headAheadOfLatestRc of [true, false]) {
            const inp = gatherLike({
              now: MON_0928,
              tags: [{ name: "v0.7.1", date: sgt("2026-09-07") }, ...tags],
              bump,
              hasFeatSinceStable,
              headAheadOfLatestRc,
              npmNext,
            });
            const r = decide(inp);
            const v = parseVersion(r.version);
            const ctx = JSON.stringify({ tags: tags.length, npmNext, bump, hasFeatSinceStable, headAheadOfLatestRc, r: r.version });
            if (v.rc !== null && npmNext) {
              assert.ok(cmpVersion(v, parseVersion(npmNext)) >= 0, `below next: ${ctx}`);
            }
            for (const t of inp.tags) {
              const p = parseVersion(t.name);
              if ((p.rc === null) === (v.rc === null)) assert.ok(cmpVersion(v, p) > 0, `not above ${t.name}: ${ctx}`);
            }
            n++;
          }
  assert.equal(n, 4 * 7 * 3 * 2 * 2);
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("daily-release-decide tests passed.");
