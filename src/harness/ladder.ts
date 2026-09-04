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
import { printProjection } from "./trace.ts";
import { runHermesAsync, hermesPrintProjection } from "./hermes-vm.ts";
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
  /**
   * P-14 (docs/PUSHBACK.md, docs/reports/2026-09-04-toolchain-artifact-
   * investigation.md): opt-in, default `false`. When `true` *and* a matched
   * sibling `hermesc` exists next to `opts.reference.vm.path` (a
   * source-built VM, v94/v99) *and* `opts.sourceJsPath` is set, the D14
   * reference run recompiles `opts.sourceJsPath`'s own content with that
   * sibling `hermesc` and runs the result, instead of `opts.hbcBytes`.
   * Opt-in rather than automatic on file-existence alone: this is only
   * sound when `opts.sourceJsPath` is *definitionally* the program
   * `opts.hbcBytes` was compiled from (true for every real caller —
   * `tiers.ts`'s gate/sweep fixture runner and every `tools/fuzz/*.mjs`
   * script always write the identical program text to both places) — a
   * test harness that deliberately passes a *different* program as
   * `sourceJsPath` than the one that produced `hbcBytes` (e.g.
   * `tests/gate/harness/ladder-uncaught.test.ts`, which does this on
   * purpose to isolate the VM cross-check) must not have that mismatch
   * silently erased by a recompile it never asked for.
   */
  readonly matchedCompilerReference?: boolean;
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
    if (cmp.maskedMatches.length > 0) {
      caveats.push(
        `${opts.fixture.name}: ${cmp.maskedMatches.length} thrown-error record(s) matched only after identifier-shaped-token masking (a non-debug-build decompiler cannot recover the original identifier text in an engine error message) — masked-match, not an exact pass: ${cmp.maskedMatches.join("; ")}`,
      );
    }

    // D14 cross-check: when a Hermes VM exists for this version, its trace of
    // the *original bytecode* is the truth, not source.js's. A divergence
    // from source.js that the Hermes VM itself also produces is not a
    // decompiler bug. This is evidence-based (docs/BUGS.md 2026-09-02, D14
    // override generalization): `vmAgreesEvidence` is set below iff a
    // Hermes VM actually ran for *this* (fixture, candidate) pair and its
    // own trace of the original bytecode matched the candidate's byte for
    // byte — never from a curated fixture-name lookup, so a fuzz-generated
    // program with no name in `KNOWN_DIVERGENT_FIXTURES` gets exactly the
    // same override a hand-written fixture does. When no VM ran at all (no
    // VM for this version, e.g. v98) or it disagreed with the candidate,
    // `vmAgreesEvidence` stays undefined and the DIVERGENT verdict below is
    // never downgraded on missing evidence — `KNOWN_DIVERGENT_FIXTURES`
    // remains the *only* fallback then (rule 3, no VM to measure with).
    let vmAgreesEvidence: string | undefined;
    if (opts.reference.engine === "hermes-vm" && opts.reference.vm !== undefined && opts.hbcBytes !== undefined) {
      const { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join, dirname } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-hermes-"));
      try {
        const hbcPath = join(dir, "original.hbc");
        // P-14 (docs/PUSHBACK.md, docs/reports/2026-09-04-toolchain-artifact-
        // investigation.md): a source-built VM (`tools/hermes-vm/v<N>/bin/
        // hermes`, v94/v99) is a *different Hermes commit* than the
        // `tools/hermesc/v<N>/hermesc` that compiled `opts.hbcBytes` — they
        // can disagree on builtin-closure indices (confirmed: v99's async
        // driver, `GetBuiltinClosure`/`_makeAsyncIterator`), which crashes
        // the VM on valid bytecode and would falsely read as a candidate
        // divergence below. When the VM has its own sibling `hermesc` next
        // to it (source-built pairing) and the fixture's own hand-written
        // source is available, recompile *that* source with the VM's own
        // matched compiler and use the result as the reference bytecode
        // instead of `opts.hbcBytes` — this is the D14 ground truth staying
        // internally consistent (one commit's compiler feeding that same
        // commit's VM). `opts.candidateJsPath`/the decompiled candidate is
        // untouched: it keeps being derived from the real
        // `tools/hermesc`-compiled bytecode, matching what an actual RN
        // bundle's decompiler input looks like — only the "what should this
        // program truly do" oracle side gets the matched compiler. No
        // sibling hermesc (v84/v96/v98's `findHermesVm` resolves to the same
        // binary tree that compiled `opts.hbcBytes` in the first place, so
        // there is no mismatch to correct) or no `sourceJsPath` falls back to
        // `opts.hbcBytes` unchanged, exactly as before.
        let referenceHbcBytes: Uint8Array = opts.hbcBytes;
        if (opts.matchedCompilerReference === true && opts.sourceJsPath !== undefined) {
          const siblingHermesc = join(dirname(opts.reference.vm.path), "hermesc");
          if (existsSync(siblingHermesc)) {
            const sourceContent = readFileSync(opts.sourceJsPath, "utf8");
            const matched = compileWithHermesc({ version: opts.reference.vm.hbcVersion, path: siblingHermesc }, sourceContent, opts.embeddedFilename ?? "source.js");
            if (matched.ok) {
              referenceHbcBytes = matched.bytes;
              caveats.push(`${opts.fixture.name}: Hermes VM v${opts.reference.vm.hbcVersion} reference recompiled from source.js with the VM's own matched hermesc (${siblingHermesc}) rather than the original .hbc, to avoid a compiler/VM commit mismatch (P-14, docs/reports/2026-09-04-toolchain-artifact-investigation.md) — informational, not a downgrade`);
            } else {
              caveats.push(`${opts.fixture.name}: Hermes VM v${opts.reference.vm.hbcVersion} has a matched hermesc (${siblingHermesc}) but it failed to recompile source.js (${matched.error}); falling back to the original .hbc for the reference run, which may still show the P-14 compiler/VM mismatch`);
            }
          }
        }
        writeFileSync(hbcPath, referenceHbcBytes);
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
        // Both sides projected the same way (CONSOLIDATION 25): print lines,
        // then `uncaught <Name>` if the program died of an uncaught throw.
        // Comparing the candidate's print-only projection against the VM's
        // raw stdout+stderr made every legitimately-throwing program look
        // DIVERGENT (the VM side carried Hermes's crash report, the
        // candidate side by construction never could). Joined then
        // compared as text, never per record (HA-07: one multi-line print
        // is one record here and several lines there).
        //
        // P-16 (docs/PUSHBACK.md, docs/BUGS.md 2026-09-04 family H1): the two
        // sides are bounded by *different* budgets — the candidate's trace by
        // `maxRecords` (and the timeout), the VM's stdout only by the
        // timeout. For a non-terminating program that alone makes them
        // differ, always, at the smaller one's cut-off (measured: 3,389,470
        // VM lines vs 4,999 candidate records for `v84-seed778059`), so the
        // verdict measured machine load rather than the decompiler. Cap both
        // sides to the same number of *lines* before comparing (line-level,
        // not record-level: one candidate print record can be several VM
        // lines, HA-07), and when either side hit a budget treat an equal
        // prefix as INCONCLUSIVE, never DIVERGENT and never as vm-agrees
        // evidence — the last capped line is dropped too, since a VM killed
        // by the timeout can be cut mid-line. A program that genuinely
        // diverges before its cut-off still compares unequal inside the
        // capped prefix and stays DIVERGENT.
        const candidateOut = printProjection(mainPhase).join("\n").split("\n");
        const vmOut = hermesPrintProjection(hermesResult).join("\n").split("\n");
        const candidateBudgetHit = ta.timedOut === true || ta.records.some((r) => r.k === "limit");
        const vmBudgetHit = hermesResult.timedOut || vmOut.length > (runOpts.maxRecords ?? 20000);
        // *Both* sides must have been cut off, not either: a candidate that
        // hung with no output while the VM ran to completion inside the same
        // budget is a real behaviour difference (that is exactly what
        // `tests/gate/harness/tiers.test.ts`'s mutation selftest detects, and
        // it must stay DIVERGENT), and so is a candidate that terminated
        // while the VM kept going. Only when neither side was allowed to
        // finish is an equal prefix evidence-free.
        const budgetHit = candidateBudgetHit && vmBudgetHit;
        const cap = budgetHit ? Math.max(0, Math.min(candidateOut.length, vmOut.length) - 1) : Math.max(candidateOut.length, vmOut.length);
        const candidatePrint = candidateOut.slice(0, cap).join("\n");
        const hermesPrint = vmOut.slice(0, cap).join("\n");
        if (candidatePrint === hermesPrint && budgetHit) {
          // Equal as far as either side was allowed to run: no evidence
          // either way. INCONCLUSIVE is never PASS (HA-01), so this can only
          // ever weaken a verdict, and a candidate-vs-Node divergence found
          // inside the prefix (cmp already DIVERGENT) is real evidence and
          // is left alone.
          caveats.push(
            `${opts.fixture.name}: Hermes VM v${opts.reference.vm.hbcVersion} cross-check hit a budget (candidate ${candidateOut.length} line(s), record cap/timeout; VM ${vmOut.length} line(s), timeout/over the candidate's record budget); the ${cap}-line common prefix is identical, so this is a budget cut-off, not a divergence (P-16) — INCONCLUSIVE, not DIVERGENT`,
          );
          if (cmp.verdict !== TRACE_VERDICT.DIVERGENT) {
            cmp = { verdict: TRACE_VERDICT.INCONCLUSIVE, why: `Hermes VM cross-check truncated by a budget after ${cap} identical line(s); the rest was never observed`, evidence: cmp.evidence, records: cmp.records, divergence: null, context: null, maskedMatches: cmp.maskedMatches };
          }
        } else if (candidatePrint !== hermesPrint) {
          // The candidate itself disagrees with the real Hermes VM's own
          // trace of the original bytecode: this is genuine evidence
          // *against* the candidate, never grounds for an override — a
          // curated known-divergence name can still excuse it (rule 3's
          // existing behaviour, unchanged), but `vmAgreesEvidence` is not
          // set, so the soundness rule below can never fire here.
          if (opts.reference.knownDivergences.length > 0) {
            caveats.push(`${opts.fixture.name}: candidate diverges from Hermes VM v${opts.reference.vm.hbcVersion}'s own trace, but this is a documented known-divergence construct (${opts.reference.knownDivergences.join(", ")}) — PASS-with-caveat`);
          } else {
            cmp = { verdict: TRACE_VERDICT.DIVERGENT, why: `candidate diverges from Hermes VM v${opts.reference.vm.hbcVersion}'s own execution of the original bytecode`, evidence: cmp.evidence, records: cmp.records, divergence: { index: -1, a: hermesPrint, b: candidatePrint }, context: null, maskedMatches: cmp.maskedMatches };
          }
        } else {
          vmAgreesEvidence = `candidatePrint === hermesPrint (Hermes VM v${opts.reference.vm.hbcVersion}'s own trace of the original .hbc byte-for-byte): ${JSON.stringify(hermesPrint)}`;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    let verdict = traceVerdictToLadder(cmp.verdict);
    if (verdict === VERDICT.DIVERGENT) {
      if (vmAgreesEvidence !== undefined) {
        // Evidence-based D14 override (docs/BUGS.md 2026-09-02, generalized
        // from the curated-name-only gate): the bytecode under the Hermes
        // VM is the D14 ground truth, and it just confirmed the candidate
        // matches it exactly, so the Node-vs-candidate divergence below is
        // legitimate source-vs-bytecode semantics, not a decompiler bug —
        // for *any* program, not only ones with a name in
        // `KNOWN_DIVERGENT_FIXTURES`.
        caveats.push(`${opts.fixture.name}: ${cmp.why} — but Hermes VM ground truth agrees with the candidate (vm-agrees evidence: ${vmAgreesEvidence}), so this is a legitimate source.js-vs-bytecode (D14) divergence, not a decompiler bug — PASS-with-caveat`);
        verdict = VERDICT.PASS;
      } else if (opts.reference.knownDivergences.length > 0) {
        // No VM ran (or none exists for this version) to confirm the
        // candidate directly: fall back to the curated fixture-name list —
        // still a caveat, never a silent pass (rule 3).
        caveats.push(`${opts.fixture.name}: ${cmp.why} — known-divergence construct (${opts.reference.knownDivergences.join(", ")}), PASS-with-caveat`);
        verdict = VERDICT.PASS;
      }
      // Else: no VM evidence and no curated name — DIVERGENT stands. Never
      // downgraded on missing evidence.
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
