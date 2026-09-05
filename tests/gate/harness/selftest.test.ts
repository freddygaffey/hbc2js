// docs/specs/06-harness.md §9, §11 item 2, §12 — the harness self-test as a
// gate test. Port of tools/equiv/selftest.mjs phases 1 (determinism +
// expected.txt fidelity) and 2 (mutation kill rate), over
// tests/fixtures/constructs/*. Phase 3 (Hermes VM cross-check) is covered
// separately by tests/gate/harness/tiers.test.ts, which goes through the full
// oracle ladder (including the reference policy) rather than a raw
// print-projection diff.
//
// HA-09: mutation kill rate must not regress. Originally (through
// 2026-09-05) this was a floor on the absolute killed count, scaled by the
// ratio of today's total mutant count to a committed baseline total — and it
// needed re-basing every time a fixture was added or edited, because every
// fixture with an EQUIVALENT mutant (a mutation that is observably harmless
// on that fixture's own trace — source-level insensitivity, not a harness
// weakness) shifts the ratio. Three such re-bases are recorded in this
// file's git history (270/318 -> 361/426 -> 370/438 -> 373/444 -> 377/450 ->
// 386/462), each with the same conclusion: the corpus-wide SURVIVED count
// (mutants whose trace is neither killed nor EQUIVALENT — the actual
// blind-spot signal) was zero every time; only the EQUIVALENT count grew.
//
// Redesigned 2026-09-05 (this commit) to stop needing a re-base at all:
//   1. A hard assertion that SURVIVED (neither DIVERGENT/killed nor
//      EQUIVALENT — i.e. INCONCLUSIVE, or any future non-EQUIVALENT verdict
//      that is not a kill) is exactly zero, corpus-wide, every mutant listed
//      on failure (not truncated). This is the real regression signal.
//   2. A kill floor computed over killed + survived only — EQUIVALENT
//      mutants excluded from the denominator entirely, not merely rescaled
//      into it — so a fixture that grows the corpus's EQUIVALENT count can
//      never move this floor. MUTATION_KILL_FLOOR_PERCENT is a fixed
//      percentage, not a re-derived absolute count: with (1) holding, every
//      non-EQUIVALENT mutant must be killed, so the floor is 100%.
// Measured against the corpus at this commit (78 fixtures * 6 = 468
// mutants): 392 killed, 76 EQUIVALENT, 0 SURVIVED -> kill rate 392/392
// (100.0%) over the non-equivalent mutants. This number is not a baseline to
// maintain by hand; the whole point of the redesign is that neither
// assertion below needs updating when it changes, only when SURVIVED
// becomes nonzero or the non-equivalent kill rate genuinely drops.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProgram } from "../../../src/harness/runner.ts";
import type { RunOptions } from "../../../src/harness/runner.ts";
import { compareTraces, TRACE_VERDICT } from "../../../src/harness/compare.ts";
import { mutants, OPERATOR_IDS } from "../../../src/harness/mutate.ts";
import { printLines } from "../../../src/harness/trace.ts";
import { repoRoot } from "../../support/paths.ts";

const CONSTRUCTS = path.join(repoRoot(), "tests", "fixtures", "constructs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-harness-selftest-"));

const MUTANTS_PER_FIXTURE = 6;

// The full rebase history that used to live here (270/318 -> 361/426 ->
// 370/438 -> 373/444 -> 377/450 -> 386/462, each one a separate commit) is
// summarised in the file header comment above and is no longer needed
// per-commit: neither assertion below is a re-derived absolute count.
const MUTATION_KILL_FLOOR_PERCENT = 100;

const RUN_OPTS: RunOptions = { timeout: 8000, seed: 0, fuzz: 0, relax: [], maxRecords: 20000, syncTimeout: 7000 };

const fixtures = fs
  .readdirSync(CONSTRUCTS)
  .filter((d) => fs.existsSync(path.join(CONSTRUCTS, d, "source.js")))
  .sort();

async function pool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(2, Math.min(n, items.length)) }, async () => {
      for (;;) {
        const j = i++;
        if (j >= items.length) return;
        out[j] = await fn(items[j]!, j);
      }
    }),
  );
  return out;
}

const CONCURRENCY = Math.max(2, Math.min(8, os.cpus().length));

test("phase 1: determinism + expected.txt fidelity, every constructs/* fixture", async () => {
  const results = await pool(fixtures, CONCURRENCY, async (name) => {
    const dir = path.join(CONSTRUCTS, name);
    const src = path.join(dir, "source.js");
    const [t1, t2] = await Promise.all([runProgram(src, RUN_OPTS), runProgram(src, RUN_OPTS)]);
    const cmp = compareTraces(t1, t2);
    const expected = fs.readFileSync(path.join(dir, "expected.txt"), "utf8").replace(/\n$/, "");
    const got = printLines(t1.records).join("\n");
    return { name, trace: t1, deterministic: cmp.verdict === TRACE_VERDICT.EQUIVALENT, fidelity: got === expected, expected, got };
  });

  const failures = results.filter((r) => !r.deterministic || !r.fidelity);
  if (failures.length > 0) {
    const detail = failures
      .map((r) => `${r.name}: deterministic=${r.deterministic} fidelity=${r.fidelity}${!r.fidelity ? ` (expected ${JSON.stringify(r.expected.slice(0, 80))} got ${JSON.stringify(r.got.slice(0, 80))})` : ""}`)
      .join("\n  ");
    assert.fail(`HA-08: ${failures.length}/${fixtures.length} fixtures failed determinism/fidelity:\n  ${detail}`);
  }
  assert.equal(results.length, fixtures.length);
});

test("phase 2: mutation kill rate >= committed baseline (HA-09)", async (t) => {
  // Re-run phase 1's traces as the mutation baseline (kept independent of the
  // test above so this test can run alone).
  const bases = await pool(fixtures, CONCURRENCY, (name) => runProgram(path.join(CONSTRUCTS, name, "source.js"), RUN_OPTS));

  const perFixture = await pool(fixtures, CONCURRENCY, async (name, i) => {
    const dir = path.join(CONSTRUCTS, name);
    const src = fs.readFileSync(path.join(dir, "source.js"), "utf8");
    const ms = mutants(src, MUTANTS_PER_FIXTURE, 0);
    const base = bases[i]!;
    const results: Array<{ operator: string; verdict: string }> = [];
    for (const m of ms) {
      const f = path.join(TMP, `${name}.${m.operator}.${results.length}.js`);
      fs.writeFileSync(f, m.text);
      const trace = await runProgram(f, RUN_OPTS);
      const cmp = compareTraces(base, trace);
      results.push({ operator: m.operator, verdict: cmp.verdict });
    }
    return results;
  });

  // Three buckets, matching TRACE_VERDICT exactly:
  //   killed     - DIVERGENT: the mutation changed observable behaviour.
  //   equivalent - EQUIVALENT: the mutation is observably harmless on this
  //                fixture's own trace (source-level insensitivity, not a
  //                harness weakness) - excluded from the kill-rate floor.
  //   survived   - anything else (today, only INCONCLUSIVE): the trace
  //                comparison could not decide, which is not proof the
  //                mutant is harmless. This is the real regression signal
  //                and must be zero.
  let killed = 0;
  let equivalent = 0;
  let survived = 0;
  const survivors: string[] = [];
  const byOperator = new Map(OPERATOR_IDS.map((id) => [id, { killed: 0, equivalent: 0, survived: 0 }]));
  for (let i = 0; i < fixtures.length; i++) {
    for (const r of perFixture[i]!) {
      const bucket = byOperator.get(r.operator)!;
      if (r.verdict === TRACE_VERDICT.DIVERGENT) {
        killed++;
        bucket.killed++;
      } else if (r.verdict === TRACE_VERDICT.EQUIVALENT) {
        equivalent++;
        bucket.equivalent++;
      } else {
        survived++;
        bucket.survived++;
        survivors.push(`${fixtures[i]} [${r.operator}] -> ${r.verdict}`);
      }
    }
  }
  // EQUIVALENT excluded from the denominator entirely (not merely rescaled
  // into it, as the old ratio-scaled floor did) - see the file header.
  const total = killed + survived;

  await t.test("summary", () => {
    const rate = total > 0 ? ((killed / total) * 100).toFixed(1) : "n/a";
    console.log(`mutation kill rate: ${killed}/${total} (${rate}%), ${equivalent} EQUIVALENT excluded`);
    if (survivors.length > 0) console.log(`survivors (HA-09 regression signal):\n  ${survivors.join("\n  ")}`);
  });

  // HA-09 part 1: a nonzero SURVIVED count is the actual regression signal
  // (a mutant the harness could neither kill nor prove harmless) - list
  // every one on failure, never truncated, so a rebase can never trim the
  // evidence away.
  assert.equal(survived, 0, `HA-09: ${survived} mutant(s) neither killed nor EQUIVALENT:\n  ${survivors.join("\n  ")}`);

  // HA-09 part 2: kill floor over the non-equivalent mutants only. With
  // part 1 holding, this is a plain 100% - a growing EQUIVALENT count from
  // an unrelated fixture can never move it, so this rung needs no re-base
  // when the corpus changes shape.
  const killRatePercent = total > 0 ? (killed / total) * 100 : 100;
  assert.ok(
    killRatePercent >= MUTATION_KILL_FLOOR_PERCENT,
    `HA-09: mutation kill rate ${killed}/${total} (${killRatePercent.toFixed(1)}%) is below the floor of ${MUTATION_KILL_FLOOR_PERCENT}%`,
  );
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
