// docs/specs/06-harness.md §2 — verdicts and the oracle ladder: cheapest and
// most specific first, stopping at the first DIVERGENT.
//
//   0. syntax     node --check candidate.js
//   1. trace      execution-trace equivalence (D2), against the fixture's own
//                 hand-written source.js when one exists (D16 C1), plus a
//                 Hermes-VM cross-check of the *original bytecode* when the
//                 reference policy (D14) says a matching VM exists — that
//                 cross-check is the actual truth; a divergence explained by
//                 reference-policy.ts's known-divergence set is downgraded to
//                 PASS-with-caveat rather than DIVERGENT.
//   2. fuzz       differential function fuzzing, sharing step 1's run
//   3. roundtrip  recompile + normalised disassembly (D3), when a hermesc
//                 build for the fixture's version and the original .hbc bytes
//                 are both available.
//
// Steps 1 and 2 share one run of each program (spec 06 §2), so they are one
// cost and one oracle entry ("trace") unless fuzz is requested, in which case
// they still share the run but are reported as two oracle entries.
import { runProgram } from "./runner.ts";
import type { RunOptions } from "./runner.ts";
import { compareTraces, TRACE_VERDICT } from "./compare.ts";
import type { TraceComparison } from "./compare.ts";
import { printLines } from "./trace.ts";
import { runHermesAsync } from "./hermes-vm.ts";
import { syntaxOk } from "./mutate.ts";
import { findHermesc, compileWithHermesc, roundTripFromBytes } from "./roundtrip.ts";
import type { RoundTripReport } from "./roundtrip.ts";
import type { ReferenceChoice } from "./reference-policy.ts";

export const VERDICT = {
  PASS: "PASS",
  DIVERGENT: "DIVERGENT",
  INCONCLUSIVE: "INCONCLUSIVE",
  ERROR: "ERROR",
} as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

export type OracleName = "syntax" | "trace" | "fuzz" | "roundtrip";

export interface Divergence {
  readonly index: number;
  readonly a: string;
  readonly b: string;
  readonly context: string | null;
}

export interface OracleResult {
  readonly oracle: OracleName;
  readonly verdict: Verdict;
  readonly detail?: string | undefined;
  readonly divergence?: Divergence | undefined;
  readonly ms: number;
}

export interface BudgetReport {
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly recordCap: number;
}

export interface FixtureRefLite {
  readonly name: string;
}

export interface CheckResult {
  readonly fixture: FixtureRefLite;
  readonly verdict: Verdict;
  readonly oracles: readonly OracleResult[];
  readonly reference: ReferenceChoice;
  readonly budgets: BudgetReport;
  /** Non-empty exactly when a known-divergence construct's would-be
   *  DIVERGENT was downgraded to PASS (spec 06 §4 rule 3). */
  readonly caveats: readonly string[];
}

export interface LadderOptions {
  readonly fixture: FixtureRefLite;
  readonly candidateJsPath: string;
  /** The fixture's hand-written source (D16 C1); omitted for inputs with no
   *  source (bundles, local-corpus) — trace/fuzz are then simply not run
   *  ("n/a", not INCONCLUSIVE, per D16's sweep/local-corpus rows). */
  readonly sourceJsPath?: string | undefined;
  readonly reference: ReferenceChoice;
  /** Original `.hbc` bytes, for the Hermes-VM cross-check and round-trip. */
  readonly hbcBytes?: Uint8Array;
  readonly hbcVersion?: number;
  /** Embedded filename the original was compiled under, for round-trip. */
  readonly embeddedFilename?: string;
  readonly oracles?: readonly OracleName[];
  readonly seed?: number;
  readonly fuzz?: number;
  readonly timeoutMs?: number;
  readonly maxRecords?: number;
  readonly relax?: readonly string[];
  readonly roundTripBaseline?: readonly boolean[];
}

const DEFAULT_ORACLES: readonly OracleName[] = ["syntax", "trace", "fuzz", "roundtrip"];

function worst(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.some((v) => v === VERDICT.ERROR)) return VERDICT.ERROR;
  if (verdicts.some((v) => v === VERDICT.DIVERGENT)) return VERDICT.DIVERGENT;
  if (verdicts.some((v) => v === VERDICT.INCONCLUSIVE)) return VERDICT.INCONCLUSIVE;
  if (verdicts.length === 0) return VERDICT.INCONCLUSIVE;
  return VERDICT.PASS;
}

function traceVerdictToLadder(v: (typeof TRACE_VERDICT)[keyof typeof TRACE_VERDICT]): Verdict {
  if (v === TRACE_VERDICT.EQUIVALENT) return VERDICT.PASS;
  if (v === TRACE_VERDICT.DIVERGENT) return VERDICT.DIVERGENT;
  return VERDICT.INCONCLUSIVE;
}

function toDivergence(cmp: TraceComparison): Divergence | undefined {
  if (cmp.divergence === null) return undefined;
  return { index: cmp.divergence.index, a: cmp.divergence.a, b: cmp.divergence.b, context: cmp.context };
}

/** Runs the whole oracle ladder for one (fixture, candidate) pair and returns
 *  a `CheckResult`. Stops running further oracles once a DIVERGENT (not
 *  caveated) or ERROR is seen, per §2. */
export async function runOracleLadder(opts: LadderOptions): Promise<CheckResult> {
  const wanted = new Set(opts.oracles ?? DEFAULT_ORACLES);
  const started = Date.now();
  const results: OracleResult[] = [];
  const caveats: string[] = [];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const runOpts: RunOptions = {
    seed: opts.seed ?? 0,
    timeout: timeoutMs,
    syncTimeout: Math.max(100, timeoutMs - 500),
    fuzz: wanted.has("fuzz") ? (opts.fuzz ?? 50) : 0,
    relax: opts.relax ?? ["fn-names"],
    maxRecords: opts.maxRecords ?? 20000,
  };

  function stopEarly(): boolean {
    const last = results[results.length - 1];
    return last !== undefined && (last.verdict === VERDICT.DIVERGENT || last.verdict === VERDICT.ERROR);
  }

  // ---- 0. syntax ----------------------------------------------------------
  if (wanted.has("syntax")) {
    const t0 = Date.now();
    const { readFileSync } = await import("node:fs");
    let ok: boolean;
    try {
      ok = syntaxOk(readFileSync(opts.candidateJsPath, "utf8"));
    } catch (e) {
      results.push({ oracle: "syntax", verdict: VERDICT.ERROR, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      return finish();
    }
    results.push({ oracle: "syntax", verdict: ok ? VERDICT.PASS : VERDICT.DIVERGENT, detail: ok ? undefined : "node --check failed", ms: Date.now() - t0 });
  }

  // ---- 1 & 2. trace + fuzz --------------------------------------------------
  if (!stopEarly() && (wanted.has("trace") || wanted.has("fuzz")) && opts.sourceJsPath !== undefined) {
    const t0 = Date.now();
    const [ta, tb] = await Promise.all([runProgram(opts.candidateJsPath, runOpts), runProgram(opts.sourceJsPath, runOpts)]);
    let cmp = compareTraces(ta, tb);

    // D14 cross-check: when a Hermes VM exists for this version, its trace of
    // the *original bytecode* is the truth, not source.js's. A divergence
    // from source.js that the Hermes VM itself also produces is not a
    // decompiler bug; a known-divergence construct is a documented case of
    // exactly that (spec 06 §4 rule 3).
    if (opts.reference.engine === "hermes-vm" && opts.reference.vm !== undefined && opts.hbcBytes !== undefined) {
      const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-hermes-"));
      try {
        const hbcPath = join(dir, "original.hbc");
        writeFileSync(hbcPath, opts.hbcBytes);
        // Async (not `runHermes`'s sync `execFileSync`): this ladder runs
        // inside `tiers.ts`'s worker pool, and a blocking syscall here would
        // stall every other pooled fixture too (see runHermesAsync's doc).
        const hermesResult = await runHermesAsync(opts.reference.vm.path, hbcPath, { timeout: timeoutMs, bytecode: true });
        // The Hermes VM never fuzzes (no injectable driver, §3.2) — its trace
        // is only the top-level program's own output. Comparing it against
        // the *fuzzed* candidate trace would spuriously "diverge" on every
        // print a fuzz-driven call happens to make. Cut the candidate's
        // trace at `globals` (child.ts's ordering: ret -> drain -> globals ->
        // [fuzz call/yield records] -> unhandled -> end), so only the main
        // program's own run is compared.
        const globalsIdx = ta.records.findIndex((r) => r.k === "globals");
        const mainPhase = globalsIdx < 0 ? ta.records : ta.records.slice(0, globalsIdx + 1);
        const candidatePrint = printLines(mainPhase).join("\n");
        const hermesPrint = hermesResult.lines.join("\n");
        if (candidatePrint !== hermesPrint) {
          if (opts.reference.knownDivergences.length > 0) {
            caveats.push(`${opts.fixture.name}: candidate diverges from Hermes VM v${opts.reference.vm.hbcVersion}'s own trace, but this is a documented known-divergence construct (${opts.reference.knownDivergences.join(", ")}) — PASS-with-caveat`);
          } else {
            cmp = { verdict: TRACE_VERDICT.DIVERGENT, why: `candidate diverges from Hermes VM v${opts.reference.vm.hbcVersion}'s own execution of the original bytecode`, evidence: cmp.evidence, records: cmp.records, divergence: { index: -1, a: hermesPrint, b: candidatePrint }, context: null };
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    let verdict = traceVerdictToLadder(cmp.verdict);
    if (verdict === VERDICT.DIVERGENT && opts.reference.knownDivergences.length > 0) {
      // Node-vs-Hermes divergence with no VM to confirm it directly: still a
      // caveat, not a failure (rule 3), same reasoning as above.
      caveats.push(`${opts.fixture.name}: ${cmp.why} — known-divergence construct (${opts.reference.knownDivergences.join(", ")}), PASS-with-caveat`);
      verdict = VERDICT.PASS;
    }

    if (wanted.has("trace")) results.push({ oracle: "trace", verdict, detail: cmp.why, divergence: toDivergence(cmp), ms: Date.now() - t0 });
    if (wanted.has("fuzz")) results.push({ oracle: "fuzz", verdict, detail: "shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)", ms: 0 });
  } else if (opts.sourceJsPath === undefined) {
    // D16: sweep / local-corpus inputs have no hand-written source. trace and
    // fuzz are "n/a", not INCONCLUSIVE — simply not run.
  }

  // ---- 3. roundtrip ---------------------------------------------------------
  if (!stopEarly() && wanted.has("roundtrip") && opts.hbcBytes !== undefined && opts.hbcVersion !== undefined) {
    const t0 = Date.now();
    const hermesc = findHermesc(opts.hbcVersion);
    if (hermesc === null) {
      results.push({ oracle: "roundtrip", verdict: VERDICT.INCONCLUSIVE, detail: `no hermesc for v${opts.hbcVersion} (run tools/get-hermesc.sh ${opts.hbcVersion})`, ms: Date.now() - t0 });
    } else {
      const { readFileSync } = await import("node:fs");
      const candidateSource = readFileSync(opts.candidateJsPath, "utf8");
      const compiled = compileWithHermesc(hermesc, candidateSource, opts.embeddedFilename ?? "source.js");
      if (!compiled.ok) {
        results.push({ oracle: "roundtrip", verdict: VERDICT.DIVERGENT, detail: `candidate does not recompile with hermesc v${opts.hbcVersion}: ${compiled.error}`, ms: Date.now() - t0 });
      } else {
        let report: RoundTripReport;
        try {
          report = roundTripFromBytes(opts.hbcBytes, compiled.bytes, opts.roundTripBaseline);
        } catch (e) {
          results.push({ oracle: "roundtrip", verdict: VERDICT.ERROR, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
          return finish();
        }
        const regressed = report.regressions.length > 0;
        const verdict = report.functionCountMismatch !== null ? VERDICT.DIVERGENT : regressed ? VERDICT.DIVERGENT : VERDICT.PASS;
        results.push({
          oracle: "roundtrip",
          verdict,
          detail: report.functionCountMismatch !== null ? `function count mismatch: original=${report.functionCountMismatch.original} recompiled=${report.functionCountMismatch.recompiled}` : `ratchet ${report.exactFunctions}/${report.totalFunctions} (${(report.ratchet * 100).toFixed(1)}%)${regressed ? `, ${report.regressions.length} regression(s)` : ""}`,
          ms: Date.now() - t0,
        });
      }
    }
  }

  return finish();

  function finish(): CheckResult {
    return {
      fixture: opts.fixture,
      verdict: worst(results.map((r) => r.verdict)),
      oracles: results,
      reference: opts.reference,
      budgets: { timeoutMs, elapsedMs: Date.now() - started, recordCap: runOpts.maxRecords ?? 20000 },
      caveats,
    };
  }
}
