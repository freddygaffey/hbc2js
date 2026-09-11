// src/harness/hbc-equiv.ts -- the callable form of `hbc2js equiv --hbc`
// (docs/specs/06-harness.md section 8) plus the function-restricted rewrite
// oracle spec 28 section 9.4's REWRITE row asks for.
//
// Why this file exists: before spec 28 landing 2 the `--hbc` oracle lived
// *inside* `src/cli.ts` (`runEquivHermes`), reachable only by spawning the
// CLI. A library that gates LLM rewrites must call the oracle in-process
// (tests/gate/harness/*.test.ts drive the harness by API, never by shelling
// out), so the comparison moves here unchanged and the CLI calls it. Nothing
// about the verdict rules changes: the Hermes VM runs the bytecode, the same
// VM runs the candidate JS as source, their printed-output projections are
// compared as text, and a run that observed nothing is INCONCLUSIVE -- never
// PASS (HA-01, the three-valued verdict rule).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAllHermesVms, findHermesVm, hbcVersion, runHermes } from "./hermes-vm.ts";
import type { HermesVm } from "./hermes-vm.ts";
import { TRACE_VERDICT, compareTraces } from "./compare.ts";
import type { TraceVerdict } from "./compare.ts";
import { runProgram } from "./runner.ts";
import type { TraceRecord } from "./trace.ts";

export interface HbcVsJsOptions {
  readonly timeoutMs?: number;
  /** Injectable VM lookup. Defaults to `findHermesVm`; a test passes its own
   *  to exercise the "no VM for this version" path deterministically on a
   *  machine that happens to have one. */
  readonly findVm?: (version: number) => HermesVm | null;
}

export interface HbcVsJsResult {
  readonly verdict: TraceVerdict;
  readonly why: string;
  /** Output lines that matched -- the evidence this verdict rests on. Zero
   *  means nothing was observed and the verdict is INCONCLUSIVE. */
  readonly lines: number;
  /** The invocation, verbatim, so the proof is reproducible by hand. */
  readonly oracle: string;
  readonly vm?: HermesVm;
}

/** `hbc2js equiv --hbc <hbc> <js>`: Hermes VM on the bytecode vs the same VM
 *  on the candidate JS source. Pure port of the CLI's own logic. */
export function hbcVsJsUnderHermes(hbcPath: string, jsPath: string, opts: HbcVsJsOptions = {}): HbcVsJsResult {
  const oracle = `hbc2js equiv --hbc ${hbcPath} ${jsPath}`;
  const timeout = opts.timeoutMs ?? 5000;
  const find = opts.findVm ?? findHermesVm;
  let version: number;
  try {
    version = hbcVersion(hbcPath);
  } catch (e) {
    return { verdict: TRACE_VERDICT.INCONCLUSIVE, why: `cannot read ${hbcPath}: ${e instanceof Error ? e.message : String(e)}`, lines: 0, oracle };
  }
  const vm = find(version);
  if (vm === null) {
    const have = findAllHermesVms()
      .map((h) => `v${String(h.hbcVersion)}`)
      .join(", ");
    return {
      verdict: TRACE_VERDICT.INCONCLUSIVE,
      why: `no Hermes VM for HBC version ${String(version)}; available: ${have === "" ? "none" : have}. The Hermes VM refuses bytecode whose version is not exactly its own (HA-05: never falls back to Node).`,
      lines: 0,
      oracle,
    };
  }
  const ra = runHermes(vm.path, hbcPath, { timeout, bytecode: true });
  const rb = runHermes(vm.path, jsPath, { timeout, bytecode: false });
  let i = 0;
  const n = Math.min(ra.lines.length, rb.lines.length);
  while (i < n && ra.lines[i] === rb.lines[i]) i++;
  const equal = ra.lines.length === rb.lines.length && i === ra.lines.length;
  const verdict = equal
    ? ra.lines.length > 0
      ? TRACE_VERDICT.EQUIVALENT
      : TRACE_VERDICT.INCONCLUSIVE
    : TRACE_VERDICT.DIVERGENT;
  const why = equal
    ? ra.lines.length > 0
      ? `${String(ra.lines.length)} output lines matched under Hermes v${String(version)}`
      : "both programs produced no output; nothing was observed"
    : `output diverges at line ${String(i + 1)}`;
  return { verdict, why, lines: equal ? ra.lines.length : i, oracle, vm };
}

// ---------------------------------------------------------------------------
// The function-restricted rewrite oracle (spec 28 section 9.4, REWRITE row)
// ---------------------------------------------------------------------------

export type FunctionEquivVerdict = "PASS" | "DIVERGENT" | "INCONCLUSIVE";

export interface FunctionEquivLeg {
  readonly name: "module-hbc" | "function-fuzz";
  readonly verdict: FunctionEquivVerdict;
  readonly why: string;
}

export interface FunctionEquivRequest {
  /** The bundle the rewrite must stay equivalent to. Ground truth (D14). */
  readonly hbcPath: string;
  /** The module render with the rewritten function spliced in. */
  readonly candidateJsPath: string;
  /** Which function the rewrite replaced. Only this function's text differs
   *  between the faithful render and the candidate -- that is what "restricted
   *  to the affected function" means here: the whole module is still run, but
   *  the only thing under test is this one function. */
  readonly fn: number;
  /** The faithful function's own text, for the fuzz leg. */
  readonly faithfulFnCode?: string;
  /** The rewritten function's own text, for the fuzz leg. */
  readonly candidateFnCode?: string;
  /** Below this many matched output lines the module run counts as THIN
   *  coverage and the fuzz leg must also pass (spec 28 section 0a). */
  readonly thinCoverageLines?: number;
  /** Run the fuzz leg even when module coverage is not thin. */
  readonly alwaysFuzz?: boolean;
  readonly fuzz?: number;
  readonly seed?: number;
  readonly timeoutMs?: number;
  readonly findVm?: (version: number) => HermesVm | null;
}

export interface FunctionEquivResult {
  readonly verdict: FunctionEquivVerdict;
  readonly why: string;
  readonly oracle: string;
  readonly coverage: { readonly inputs: number; readonly records: number };
  readonly legs: readonly FunctionEquivLeg[];
}

export const DEFAULT_THIN_COVERAGE_LINES = 3;
export const DEFAULT_REWRITE_FUZZ = 50;

/** The REWRITE gate's oracle. Two legs, and the weaker one can only ever
 *  *lower* the verdict:
 *
 *  1. `module-hbc` -- `hbc2js equiv --hbc <bundle.hbc> <candidate.js>`. This
 *     is the guarantee: Hermes-VM behaviour of the bytecode vs the rewritten
 *     JS. Anything but EQUIVALENT here rejects, and a missing VM (or a run
 *     that observed nothing) is INCONCLUSIVE, which is never PASS.
 *  2. `function-fuzz` -- differential fuzzing of the faithful function against
 *     the rewritten one over spec-09's seeded corpus, run when the module's
 *     own trace coverage is thin (few output lines) or when the caller asks
 *     for it. It compares rewrite against faithful, so it can refute a rewrite
 *     the module run never exercised; it can never substitute for leg 1.
 */
export async function runFunctionEquiv(req: FunctionEquivRequest): Promise<FunctionEquivResult> {
  const thin = req.thinCoverageLines ?? DEFAULT_THIN_COVERAGE_LINES;
  const module_ = hbcVsJsUnderHermes(req.hbcPath, req.candidateJsPath, {
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.findVm !== undefined ? { findVm: req.findVm } : {}),
  });
  const moduleLeg: FunctionEquivLeg = {
    name: "module-hbc",
    verdict: module_.verdict === TRACE_VERDICT.EQUIVALENT ? "PASS" : module_.verdict === TRACE_VERDICT.DIVERGENT ? "DIVERGENT" : "INCONCLUSIVE",
    why: module_.why,
  };
  const oracle = module_.oracle;
  if (moduleLeg.verdict !== "PASS") {
    return {
      verdict: moduleLeg.verdict,
      why: `fn ${String(req.fn)}: ${module_.why}`,
      oracle,
      coverage: { inputs: 0, records: module_.lines },
      legs: [moduleLeg],
    };
  }

  const wantFuzz =
    (req.alwaysFuzz === true || module_.lines < thin) && req.faithfulFnCode !== undefined && req.candidateFnCode !== undefined;
  if (!wantFuzz) {
    if (module_.lines < thin) {
      // Thin coverage and no function text to fuzz with: we cannot honestly
      // call this proven. INCONCLUSIVE rejects (spec 28 section 9.4).
      return {
        verdict: "INCONCLUSIVE",
        why: `fn ${String(req.fn)}: only ${String(module_.lines)} output line(s) observed (thin coverage, threshold ${String(thin)}) and no function body was supplied to fuzz`,
        oracle,
        coverage: { inputs: 0, records: module_.lines },
        legs: [moduleLeg],
      };
    }
    return { verdict: "PASS", why: `fn ${String(req.fn)}: ${module_.why}`, oracle, coverage: { inputs: 0, records: module_.lines }, legs: [moduleLeg] };
  }

  const fuzz = await fuzzFunctions(req.faithfulFnCode as string, req.candidateFnCode as string, req);
  const legs = [moduleLeg, fuzz.leg];
  const coverage = { inputs: fuzz.inputs, records: module_.lines + fuzz.records };
  const combinedOracle = `${oracle} ; ${fuzz.oracle}`;
  if (fuzz.leg.verdict !== "PASS") {
    return { verdict: fuzz.leg.verdict, why: `fn ${String(req.fn)}: ${fuzz.leg.why}`, oracle: combinedOracle, coverage, legs };
  }
  return { verdict: "PASS", why: `fn ${String(req.fn)}: ${module_.why}; ${fuzz.leg.why}`, oracle: combinedOracle, coverage, legs };
}

interface FuzzLegResult {
  readonly leg: FunctionEquivLeg;
  readonly inputs: number;
  readonly records: number;
  readonly oracle: string;
}

/** Differential fuzzing of two versions of ONE function. Each side is written
 *  as a standalone program whose only global is that function, so the
 *  harness's fuzz driver (`child.ts`, spec 06 section 3.2) calls exactly it
 *  and nothing else -- the "restricted to the affected function" half of the
 *  REWRITE row. */
async function fuzzFunctions(faithful: string, candidate: string, req: FunctionEquivRequest): Promise<FuzzLegResult> {
  const fuzz = req.fuzz ?? DEFAULT_REWRITE_FUZZ;
  const seed = req.seed ?? 0;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-fn-equiv-"));
  try {
    const a = join(dir, "faithful.js");
    const b = join(dir, "candidate.js");
    writeFileSync(a, `${faithful}\n`);
    writeFileSync(b, `${candidate}\n`);
    const oracle = `hbc2js equiv --fuzz=${String(fuzz)} --seed ${String(seed)} <faithful fn ${String(req.fn)}> <rewritten fn ${String(req.fn)}>`;
    const opts = { seed, fuzz, timeout: req.timeoutMs ?? 5000, syncTimeout: Math.max(100, (req.timeoutMs ?? 5000) - 500), maxRecords: 20000 };
    const [ta, tb] = await Promise.all([runProgram(a, opts), runProgram(b, opts)]);
    const cmp = compareTraces(tb, ta);
    const calls = countCalls(tb.records);
    if (cmp.verdict === TRACE_VERDICT.DIVERGENT) {
      return { leg: { name: "function-fuzz", verdict: "DIVERGENT", why: `fuzzed calls diverge: ${cmp.why}` }, inputs: calls.total, records: cmp.records, oracle };
    }
    if (cmp.verdict === TRACE_VERDICT.INCONCLUSIVE) {
      return { leg: { name: "function-fuzz", verdict: "INCONCLUSIVE", why: `fuzz leg inconclusive: ${cmp.why}` }, inputs: calls.total, records: cmp.records, oracle };
    }
    if (calls.returned === 0) {
      // Every fuzzed call threw (or none ran): "both sides failed the same
      // way" is not evidence of equivalence. HA-01 again.
      return {
        leg: {
          name: "function-fuzz",
          verdict: "INCONCLUSIVE",
          why: `no fuzzed call returned a value on either side (${String(calls.total)} call(s), all threw); nothing was observed`,
        },
        inputs: calls.total,
        records: cmp.records,
        oracle,
      };
    }
    return {
      leg: { name: "function-fuzz", verdict: "PASS", why: `${String(calls.total)} fuzzed call(s) agreed (${String(calls.returned)} returned a value)` },
      inputs: calls.total,
      records: cmp.records,
      oracle,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function countCalls(records: readonly TraceRecord[]): { readonly total: number; readonly returned: number } {
  let total = 0;
  let returned = 0;
  for (const r of records) {
    if (r.k !== "call") continue;
    total += 1;
    if ((r as { throws?: unknown }).throws === undefined) returned += 1;
  }
  return { total, returned };
}
