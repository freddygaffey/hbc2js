// src/readability/rewrite.ts -- spec 28 landing 2: the REWRITE path.
//
// Fred's safety harness (spec 28 section 0a) in one sentence: the LLM may
// rewrite a function, but the result is kept ONLY if the equivalence oracle
// says the program still behaves identically to the bytecode. This file is the
// gate that enforces it. It never mutates the faithful render on disk: the
// faithful text is an input, the candidate lives in a temp file for the length
// of the oracle run, and what a caller gets back on a rejection is the
// faithful text unchanged.
//
// Verdicts, all of them terminal (spec 28 section 9.4's REWRITE row):
//   ACCEPTED               -- oracle PASS; a `suggested` change record is made
//   REJECTED_PARSE         -- the candidate (or the spliced module) is not
//                             valid JS; the oracle is never even run
//   REJECTED_SHAPE         -- the candidate is valid JS but is not a function
//                             declaration named like the one it replaces, or
//                             the faithful function cannot be located
//   REJECTED_DIVERGENT     -- oracle DIVERGENT
//   REJECTED_INCONCLUSIVE  -- oracle INCONCLUSIVE. Never PASS (the harness
//                             rule); thin coverage rejects exactly like a
//                             proven difference does.
//
// Like `name-pass.ts` this module imports NO transport. It does import the
// harness oracle, and `opts.oracle` lets a caller inject another one (the gate
// uses that to exercise the INCONCLUSIVE path without needing a VM that does
// not exist).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntaxOk } from "../harness/mutate.ts";
import { runFunctionEquiv } from "../harness/hbc-equiv.ts";
import type { FunctionEquivRequest, FunctionEquivResult } from "../harness/hbc-equiv.ts";
import { equivAccepts } from "./types.ts";
import type { BindingOrigin, EmittedFile, EquivProof, RewriteProposal, TransactionProblem } from "./types.ts";
import type { Confidence } from "../name-overlay/store.ts";

export type RewriteVerdict = "ACCEPTED" | "REJECTED_PARSE" | "REJECTED_SHAPE" | "REJECTED_DIVERGENT" | "REJECTED_INCONCLUSIVE";

/** The emitter's name for function index `fn` (`src/emit`: `_fn0`, `_fn1`,
 *  ...). Overridable because a renamed render (the name overlay) can call it
 *  something else. */
export function emittedFunctionName(fn: number): string {
  return `_fn${String(fn)}`;
}

export interface FunctionSpan {
  readonly start: number;
  readonly end: number;
}

/** Locate `function <name>(...) { ... }` in rendered JS and return its span.
 *  Brace matching is done by a small scanner that understands line/block
 *  comments, the three string forms (including `${}` nesting) and the usual
 *  regex-literal heuristic. It FAILS CLOSED: anything it cannot match with
 *  confidence returns `undefined`, and the gate then rejects the rewrite
 *  rather than splicing text at a guessed offset. */
export function findFunctionSpan(code: string, name: string): FunctionSpan | undefined {
  const re = new RegExp(`(?<![\\w$.])function\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\(`, "g");
  const m = re.exec(code);
  if (m === null) return undefined;
  if (re.exec(code) !== null) return undefined; // ambiguous: two declarations of the same name
  const start = m.index;
  const open = code.indexOf("{", m.index + m[0].length);
  if (open < 0) return undefined;
  const end = matchBrace(code, open);
  if (end === undefined) return undefined;
  return { start, end: end + 1 };
}

function matchBrace(code: string, open: number): number | undefined {
  let depth = 0;
  let prev = "";
  for (let i = open; i < code.length; i++) {
    const c = code[i] as string;
    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      if (nl < 0) return undefined;
      i = nl;
      prev = "\n";
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      if (close < 0) return undefined;
      i = close + 1;
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'") {
      const close = skipString(code, i, c);
      if (close === undefined) return undefined;
      i = close;
      prev = c;
      continue;
    }
    if (c === "`") {
      const close = skipTemplate(code, i);
      if (close === undefined) return undefined;
      i = close;
      prev = c;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prev)) {
      const close = skipRegex(code, i);
      if (close === undefined) return undefined;
      i = close;
      prev = "/";
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return undefined;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return undefined;
}

function skipString(code: string, i: number, quote: string): number | undefined {
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === quote) return j;
    if (c === "\n") return undefined;
  }
  return undefined;
}

function skipTemplate(code: string, i: number): number | undefined {
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "`") return j;
    if (c === "$" && code[j + 1] === "{") {
      const close = matchBrace(code, j + 1);
      if (close === undefined) return undefined;
      j = close;
    }
  }
  return undefined;
}

function regexCanStartAfter(prev: string): boolean {
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

function skipRegex(code: string, i: number): number | undefined {
  let inClass = false;
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "\n") return undefined;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j;
  }
  return undefined;
}

export type SpliceOutcome =
  | { readonly ok: true; readonly code: string; readonly faithfulFnCode: string; readonly candidateFnCode: string }
  | { readonly ok: false; readonly verdict: Extract<RewriteVerdict, "REJECTED_PARSE" | "REJECTED_SHAPE">; readonly detail: string };

/** Parse the candidate and splice it into the faithful render in place of the
 *  function it replaces. Everything outside that one span stays byte-identical
 *  by construction -- the splice is prefix + candidate + suffix. */
export function spliceRewrite(faithfulCode: string, proposal: RewriteProposal, fnName?: string): SpliceOutcome {
  const name = fnName ?? emittedFunctionName(proposal.fn);
  const candidate = proposal.code.trim();
  if (candidate === "") return { ok: false, verdict: "REJECTED_PARSE", detail: "empty rewrite" };
  if (!syntaxOk(candidate)) return { ok: false, verdict: "REJECTED_PARSE", detail: "rewrite is not valid JavaScript" };
  const candidateSpan = findFunctionSpan(candidate, name);
  if (candidateSpan === undefined) {
    return { ok: false, verdict: "REJECTED_SHAPE", detail: `rewrite must be exactly one \`function ${name}(...)\` declaration` };
  }
  if (candidateSpan.start !== 0 || candidateSpan.end !== candidate.length) {
    return { ok: false, verdict: "REJECTED_SHAPE", detail: `rewrite must contain nothing but the \`function ${name}\` declaration` };
  }
  const span = findFunctionSpan(faithfulCode, name);
  if (span === undefined) {
    return { ok: false, verdict: "REJECTED_SHAPE", detail: `cannot locate \`function ${name}\` in the faithful render` };
  }
  const faithfulFnCode = faithfulCode.slice(span.start, span.end);
  const code = faithfulCode.slice(0, span.start) + candidate + faithfulCode.slice(span.end);
  if (!syntaxOk(code)) return { ok: false, verdict: "REJECTED_PARSE", detail: "the spliced module is not valid JavaScript" };
  return { ok: true, code, faithfulFnCode, candidateFnCode: candidate };
}

// ---------------------------------------------------------------------------
// The change record (spec 28 section 9.5's shape, for the landing-3 log)
// ---------------------------------------------------------------------------

/** What an ACCEPTED rewrite is stored as. Field for field this is spec 28
 *  section 9.5's transaction, minus `op`: the section's `FileOpKind` enum has
 *  no value for "rewrote one function" (docs/PUSHBACK.md P-58), so landing 2
 *  records `change: "rewrite"` and landing 3 maps it into the table. */
export interface RewriteChangeRecord {
  readonly id: string;
  readonly change: "rewrite";
  readonly fn: number;
  readonly who: string;
  readonly tier: "suggested";
  readonly ts: string;
  readonly inputs: readonly BindingOrigin[];
  readonly outputs: readonly EmittedFile[];
  readonly equiv: EquivProof;
  readonly evidence: string;
  readonly confidence: Confidence;
  /** The accepted function text. The faithful original is `prior`. */
  readonly code: string;
  readonly prior: { readonly files: readonly { readonly path: string; readonly sha256: string }[] };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The same structural rules `validateTransaction` applies, for the rewrite
 *  record shape: every output traces to bytecode, there is an input, the prior
 *  state is recorded (a rewrite always replaces something), the proof passed,
 *  and a worker never writes `confirmed`. */
export function validateRewriteRecord(r: RewriteChangeRecord): readonly TransactionProblem[] {
  const problems: TransactionProblem[] = [];
  if (r.inputs.length === 0) problems.push({ code: "no-inputs", detail: `${r.id}: no input binding origins` });
  for (const f of r.outputs) {
    if (f.origins.length === 0) problems.push({ code: "orphan-file", detail: `${f.path} traces to no bytecode origin` });
  }
  if (r.prior.files.length === 0) problems.push({ code: "not-reversible", detail: `${r.id}: rewrite records no prior state` });
  if (!equivAccepts(r.equiv)) problems.push({ code: "equiv-not-passed", detail: `${r.id}: equiv verdict ${r.equiv.verdict}` });
  if ((r.tier as string) === "confirmed" && r.who.startsWith("worker:")) {
    problems.push({ code: "self-promoted", detail: `${r.who} may not write tier=confirmed (spec 28 section 1)` });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type FunctionEquivOracle = (req: FunctionEquivRequest) => Promise<FunctionEquivResult>;

export interface RewriteGateOptions {
  /** The faithful render of the module the function lives in. Never written
   *  to disk by this module, never mutated. */
  readonly faithfulCode: string;
  /** The bytecode the rewrite must stay equivalent to (ground truth, D14). */
  readonly hbcPath: string;
  /** Emitted path the render corresponds to, recorded in the change record. */
  readonly outputPath?: string;
  /** Provenance: where this function came from in the bytecode. */
  readonly inputs?: readonly BindingOrigin[];
  readonly who?: string;
  readonly fnName?: string;
  readonly oracle?: FunctionEquivOracle;
  readonly fuzz?: number;
  readonly seed?: number;
  readonly timeoutMs?: number;
  readonly alwaysFuzz?: boolean;
  readonly thinCoverageLines?: number;
  readonly now?: () => Date;
}

export interface RewriteAttempt {
  readonly fn: number;
  readonly verdict: RewriteVerdict;
  readonly accepted: boolean;
  readonly detail: string;
  /** Present whenever the oracle ran -- including on a rejection, because the
   *  attempt is logged with its proof (spec 28 section 9.4). */
  readonly proof?: EquivProof;
  readonly record?: RewriteChangeRecord;
  /** The render that stands. The faithful input on every rejection. */
  readonly code: string;
}

/** Gate ONE rewrite proposal. The only path that returns a changed `code` is
 *  the one where `equivAccepts(proof)` is true. */
export async function gateRewrite(proposal: RewriteProposal, opts: RewriteGateOptions): Promise<RewriteAttempt> {
  const spliced = spliceRewrite(opts.faithfulCode, proposal, opts.fnName);
  if (!spliced.ok) {
    return { fn: proposal.fn, verdict: spliced.verdict, accepted: false, detail: spliced.detail, code: opts.faithfulCode };
  }

  const oracle = opts.oracle ?? runFunctionEquiv;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-rewrite-"));
  let result: FunctionEquivResult;
  try {
    const candidatePath = join(dir, `candidate-fn${String(proposal.fn)}.js`);
    writeFileSync(candidatePath, spliced.code);
    result = await oracle({
      hbcPath: opts.hbcPath,
      candidateJsPath: candidatePath,
      fn: proposal.fn,
      faithfulFnCode: spliced.faithfulFnCode,
      candidateFnCode: spliced.candidateFnCode,
      ...(opts.fuzz !== undefined ? { fuzz: opts.fuzz } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.alwaysFuzz !== undefined ? { alwaysFuzz: opts.alwaysFuzz } : {}),
      ...(opts.thinCoverageLines !== undefined ? { thinCoverageLines: opts.thinCoverageLines } : {}),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const ts = (opts.now ?? (() => new Date()))().toISOString();
  const proof: EquivProof = {
    scope: "function",
    verdict: result.verdict,
    oracle: result.oracle,
    coverage: result.coverage,
    ts,
  };
  if (!equivAccepts(proof)) {
    return {
      fn: proposal.fn,
      verdict: result.verdict === "DIVERGENT" ? "REJECTED_DIVERGENT" : "REJECTED_INCONCLUSIVE",
      accepted: false,
      detail: result.why,
      proof,
      code: opts.faithfulCode,
    };
  }

  const outputPath = opts.outputPath ?? "module.js";
  const inputs = opts.inputs ?? [{ module: 0 }];
  const record: RewriteChangeRecord = {
    id: sha256([`rewrite`, String(proposal.fn), outputPath, spliced.candidateFnCode, proposal.evidence].join("\n")),
    change: "rewrite",
    fn: proposal.fn,
    who: opts.who ?? "worker:haiku",
    tier: "suggested",
    ts,
    inputs,
    outputs: [{ path: outputPath, origins: inputs }],
    equiv: proof,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
    code: spliced.candidateFnCode,
    prior: { files: [{ path: outputPath, sha256: sha256(opts.faithfulCode) }] },
  };
  return { fn: proposal.fn, verdict: "ACCEPTED", accepted: true, detail: result.why, proof, record, code: spliced.code };
}

export interface RewritePassResult {
  readonly attempts: readonly RewriteAttempt[];
  /** The render that stands after the whole pass: the faithful render with
   *  every ACCEPTED rewrite applied, and nothing else. */
  readonly code: string;
  readonly records: readonly RewriteChangeRecord[];
}

/** Gate a batch of proposals in order. Each is checked against the bytecode on
 *  top of whatever has already been accepted, so the surviving render is
 *  proven as a whole, not proposal by proposal in isolation. */
export async function runRewritePass(proposals: readonly RewriteProposal[], opts: RewriteGateOptions): Promise<RewritePassResult> {
  let code = opts.faithfulCode;
  const attempts: RewriteAttempt[] = [];
  const records: RewriteChangeRecord[] = [];
  for (const proposal of proposals) {
    const attempt = await gateRewrite(proposal, { ...opts, faithfulCode: code });
    attempts.push(attempt);
    if (attempt.accepted) {
      code = attempt.code;
      if (attempt.record !== undefined) records.push(attempt.record);
    }
  }
  return { attempts, code, records };
}

/** The JSON sidecar landing 3's transaction log will subsume. Derived data:
 *  rebuildable from the bytecode plus the proposals, never authoritative. */
export function rewriteSidecar(records: readonly RewriteChangeRecord[]): string {
  return `${JSON.stringify({ version: 1, records }, null, 2)}\n`;
}
