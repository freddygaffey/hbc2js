// tests/gate/llm-readability/record-scope.test.ts -- spec 28 section 7's
// "held-out recording" bound (docs/READABILITY.md "Recording" section):
// `tools/readability/record.ts`'s `--only src`, `--sample`/`--seed` and
// `--resume`, so the react-navigation-example-0.85.3 recording does not have
// to walk the whole ~15k-function bundle. No network, no model call anywhere
// in this file -- `--backend fake` (`FakeBackend`, deterministic replies) or
// a hand-built `Recording` JSON only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { OverlayStore } from "../../../src/name-overlay/index.ts";
import { computeSrcScope } from "../../../src/readability/scope.ts";
import { collectTargets, mulberry32, renderTargetSource, seededSample, type Target } from "../../../tools/readability/record.ts";
import type { Recording } from "../../../src/workers/backends/replay.ts";

const RECORD = join(repoRoot(), "tools", "readability", "record.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const CONSTRUCT = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [RECORD, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

// -- 1. `--only src` selects exactly the classifier's set --------------------
//
// `computeSrcScope`'s `srcFns` IS the population `--only src` restricts to
// (record.ts's own `srcFns` variable, passed straight into `collectTargets`
// as `allowedFns`); this proves `collectTargets(..., scope.srcFns)` returns
// exactly the subset of the unrestricted enumeration whose `fn` is in
// `scope.srcFns` -- not a second, drifted definition of "src". Uses
// rn-template-0.72 (small, always fetched, "used by every other test" in
// tests/gate/split/segregate.test.ts) rather than the much larger held-out
// app, so the unrestricted sweep this test also runs stays cheap.
test("computeSrcScope + collectTargets: --only src's population is exactly {targets whose fn is a src-bucket module's}", async () => {
  const bytes = new Uint8Array(readFileSync(RN_TEMPLATE));
  const scope = await computeSrcScope(RN_TEMPLATE, bytes, { moduleName: "index.android.hbc" });
  assert.ok(scope.srcModuleCount > 0, "rn-template-0.72 must classify at least one module as src");
  assert.ok(scope.srcModuleCount <= scope.totalModuleCount);
  assert.ok(scope.srcFns.size > 0, "at least one function must belong to a src-bucket module");

  const store = new OverlayStore({ bundle: RN_TEMPLATE });
  const frames = rawFrameBodies(scope.analysis, { strictEnv: false });

  const full = collectTargets(scope.analysis, frames, store, null);
  const scoped = collectTargets(scope.analysis, frames, store, scope.srcFns);

  const expected = full.filter((t) => scope.srcFns.has(t.fn));
  assert.deepEqual(
    scoped.map((t) => `${String(t.fn)}:${String(t.reg)}`).sort(),
    expected.map((t) => `${String(t.fn)}:${String(t.reg)}`).sort(),
    "--only src's selection must equal the unrestricted sweep filtered to computeSrcScope's own srcFns",
  );
  for (const t of scoped) assert.ok(scope.srcFns.has(t.fn), `target fn${t.fn} leaked in from outside the src scope`);
});

test("renderTargetSource: renders each fn at most once (memoized) and skips an oversized source rather than returning it", () => {
  const calls: number[] = [];
  const render = (fn: number): string => {
    calls.push(fn);
    return fn === 9 ? "x".repeat(48 * 1024 + 1) : `fn${String(fn)} source`;
  };
  const cache = new Map<number, string>();
  const diagnostics: string[] = [];

  assert.equal(renderTargetSource(1, render, cache, diagnostics), "fn1 source");
  assert.equal(renderTargetSource(1, render, cache, diagnostics), "fn1 source");
  assert.deepEqual(calls, [1], "the second call for the same fn must come from the cache, not a second render()");

  assert.equal(renderTargetSource(9, render, cache, diagnostics), null, "a source over MAX_SOURCE_BYTES must be refused, never handed to a prompt");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /skip fn 9/);
});

// -- 2. `--sample N --seed S` is deterministic and seed-varying --------------

test("seededSample: same seed is deterministic across two calls, a different seed samples independently", () => {
  const items: Target[] = [];
  for (let fn = 0; fn < 50; fn++) for (let reg = 0; reg < 4; reg++) items.push({ fn, reg });

  const a1 = seededSample(items, 5, 1);
  const a2 = seededSample(items, 5, 1);
  assert.deepEqual(a1, a2, "same items + same seed must reproduce the identical sample");

  const b = seededSample(items, 5, 2);
  const keyOf = (t: Target): string => `${String(t.fn)}:${String(t.reg)}`;
  const setA = new Set(a1.map(keyOf));
  const setB = new Set(b.map(keyOf));
  const overlap = [...setA].filter((k) => setB.has(k));
  assert.ok(overlap.length < setA.size, "seed 1 and seed 2 must not sample identically over a 200-item population");

  // Every sampled item really is drawn from the original population, and a
  // sample >= population returns everything, unshuffled.
  for (const t of a1) assert.ok(items.some((it) => it.fn === t.fn && it.reg === t.reg));
  assert.deepEqual(seededSample(items, items.length + 10, 7), items);
});

test("mulberry32: deterministic sequence for a fixed seed, differs across seeds", () => {
  const seq = (seed: number): number[] => {
    const rng = mulberry32(seed);
    return [rng(), rng(), rng()];
  };
  assert.deepEqual(seq(1), seq(1));
  assert.notDeepEqual(seq(1), seq(2));
});

test("record.ts CLI: --sample 5 --seed 1 recording is identical across two runs, and disjoint-ish from --seed 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-record-sample-"));
  try {
    const out1a = join(dir, "seed1a.json");
    const out1b = join(dir, "seed1b.json");
    const out2 = join(dir, "seed2.json");
    const r1a = run([CONSTRUCT, out1a, "--backend", "fake", "--sample", "5", "--seed", "1"]);
    assert.equal(r1a.status, 0, r1a.stderr);
    const r1b = run([CONSTRUCT, out1b, "--backend", "fake", "--sample", "5", "--seed", "1"]);
    assert.equal(r1b.status, 0, r1b.stderr);
    const r2 = run([CONSTRUCT, out2, "--backend", "fake", "--sample", "5", "--seed", "2"]);
    assert.equal(r2.status, 0, r2.stderr);

    const rec1a = JSON.parse(readFileSync(out1a, "utf8")) as Recording;
    const rec1b = JSON.parse(readFileSync(out1b, "utf8")) as Recording;
    const rec2 = JSON.parse(readFileSync(out2, "utf8")) as Recording;
    assert.deepEqual(rec1a, rec1b, "same --seed must record the identical set of targets with identical (fake, deterministic) text");
    const keys1 = new Set(Object.keys(rec1a));
    const keys2 = new Set(Object.keys(rec2));
    assert.ok(keys1.size > 0, "the construct fixture must have at least one nameable target to sample");
    const overlap = [...keys1].filter((k) => keys2.has(k));
    assert.ok(overlap.length < keys1.size || keys1.size < 2, "--seed 1 and --seed 2 must not select the identical target set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- 3. `--resume` makes zero backend calls for already-recorded keys -------

test("record.ts CLI: --resume answers already-recorded keys without a backend call", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-record-resume-"));
  try {
    const out = join(dir, "resume.json");
    const first = run([CONSTRUCT, out, "--backend", "fake", "--limit", "2"]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(out));
    const before = JSON.parse(readFileSync(out, "utf8")) as Recording;
    const keys = Object.keys(before);
    assert.ok(keys.length >= 1, "the construct fixture must yield at least one recorded target");

    // Poison one entry with a marker text `FakeBackend`'s own deterministic
    // reply would never produce -- if `--resume` called the backend again
    // for this key, the marker would be overwritten.
    const poisoned: Recording = { ...before, [keys[0]!]: { text: "MARKER_UNCALLED", cost: { tokensIn: 0, tokensOut: 0 } } };
    writeFileSync(out, `${JSON.stringify(poisoned, null, 2)}\n`);

    const second = run([CONSTRUCT, out, "--backend", "fake", "--limit", "2", "--resume"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /cache hit/i);
    assert.match(second.stderr, / 0 call\(s\)/, "every target in --limit 2's population was already recorded -- zero new backend calls");

    const after = JSON.parse(readFileSync(out, "utf8")) as Recording;
    assert.equal(after[keys[0]!]?.text, "MARKER_UNCALLED", "--resume must not re-call the backend for an already-recorded key");
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "--resume must not drop or add keys outside the run's own target set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record.ts CLI: usage line documents --only, --sample/--seed and --resume", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--only src/);
  assert.match(r.stderr, /--sample N/);
  assert.match(r.stderr, /--seed S/);
  assert.match(r.stderr, /--resume/);
});
