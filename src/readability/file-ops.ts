// src/readability/file-ops.ts -- make / rename / move / combine / split over a
// split tree (docs/specs/08-segregation.md's `MODULES.json` + `module_<id>.js`
// shape), each one an equiv-gated, DB-recorded transaction
// (docs/specs/28-llm-readability.md sections 1c, 9.4's FILE OP row, 9.5).
//
// The rule is section 0a's, at tree granularity: ACCEPT IFF EQUIVALENT. A
// proposed op is materialised into a STAGING copy of the tree, the whole
// reconstructed tree is put through the gate, and only a PASS is applied to
// the real tree and recorded. A failure leaves the tree untouched, byte for
// byte, and returns the attempt with the oracle's verdict so a human can see
// what was tried and rejected.
//
// The gate has two legs and both must pass:
//   1. STRUCTURE (in process, no VM): the require graph resolves identically
//      -- every module id still has a file, every dependency id still
//      resolves -- and the export surface is preserved.
//   2. BEHAVIOUR: `hbcVsJsUnderHermes` over the tree's entry, i.e. the
//      project's `equiv --hbc` oracle, verdict PASS. DIVERGENT and
//      INCONCLUSIVE both reject; INCONCLUSIVE is never PASS.
import type { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { hbcVsJsUnderHermes } from "../harness/hbc-equiv.ts";
import { recordTransaction, sha256, traceFile, transactionId } from "./transactions.ts";
import type { BindingOrigin, EmittedFile, EquivProof, FileOpKind, ReadabilityTransaction } from "./types.ts";

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** Every text file in the tree, keyed by its path relative to the root. */
export type TreeSnapshot = ReadonlyMap<string, string>;

const TEXT_EXT = [".js", ".json", ".cjs", ".mjs", ".ts"];

export function readTree(treeDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!TEXT_EXT.some((x) => e.name.endsWith(x))) continue;
      out.set(relative(treeDir, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
    }
  };
  if (existsSync(treeDir) && statSync(treeDir).isDirectory()) walk(treeDir);
  return out;
}

/** sha256 over every path+content, in path order -- the "prior tree hash" the
 *  reversibility exit criterion is stated in terms of. */
export function treeHash(snapshot: TreeSnapshot): string {
  return sha256([...snapshot.keys()].sort().map((p) => `${p}\u0000${snapshot.get(p) ?? ""}`).join("\u0001"));
}

export interface ModulesIndex {
  entry?: number;
  modules: { id: number; file: string; deps?: number[] }[];
}

export const MODULES_JSON = "MODULES.json";

/** Reads `MODULES.json` defensively: an unparseable or absent index is an
 *  EMPTY index, not a throw, so a file op over a tree that has no index (a
 *  hand-made fixture, a single-module render) still works and is still gated
 *  -- there is simply no require graph to compare. */
export function readModulesIndex(snapshot: TreeSnapshot): ModulesIndex {
  const raw = snapshot.get(MODULES_JSON);
  if (raw === undefined) return { modules: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<ModulesIndex>;
    const modules = Array.isArray(parsed.modules) ? parsed.modules.filter((m) => typeof m?.id === "number" && typeof m?.file === "string") : [];
    return parsed.entry !== undefined ? { entry: parsed.entry, modules } : { modules };
  } catch {
    return { modules: [] };
  }
}

/** The require graph as a comparable value: module id -> the file it resolves
 *  to plus the dependency ids it names. Two trees whose graphs differ here
 *  do NOT resolve identically. */
function requireGraph(snapshot: TreeSnapshot): string {
  const index = readModulesIndex(snapshot);
  const rows = index.modules
    .map((m) => `${m.id}=>${snapshot.has(m.file) ? "present" : "MISSING"}:[${[...(m.deps ?? [])].sort((a, b) => a - b).join(",")}]`)
    .sort();
  return `entry=${index.entry ?? "none"};${rows.join(";")}`;
}

const EXPORT_RE = /\bexports\s*\.\s*([A-Za-z_$][\w$]*)|\bmodule\s*\.\s*exports\b/g;

/** The export surface of the WHOLE tree: every `exports.<name>` and every
 *  `module.exports`, as a sorted multiset. Combining or splitting files moves
 *  code between files but must never add or drop an export. */
function exportSurface(snapshot: TreeSnapshot): string {
  const found: string[] = [];
  for (const [path, content] of [...snapshot].sort()) {
    if (path === MODULES_JSON) continue;
    for (const m of content.matchAll(EXPORT_RE)) found.push(m[1] ?? "module.exports");
  }
  return found.sort().join(",");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface TreeEquivRequest {
  /** The staged tree to judge. */
  readonly treeDir: string;
  /** Ground truth (D14): the bytecode the tree must still behave like. */
  readonly hbcPath?: string;
  /** Entry file, relative to `treeDir`. */
  readonly entry: string;
}

export interface TreeEquivResult {
  readonly verdict: "PASS" | "DIVERGENT" | "INCONCLUSIVE";
  readonly why: string;
  readonly oracle: string;
  readonly lines: number;
}

export type TreeEquivOracle = (req: TreeEquivRequest) => TreeEquivResult;

/** The shipped oracle: the project's own `equiv --hbc` comparison over the
 *  tree's entry. No bytecode to compare against means INCONCLUSIVE -- and
 *  INCONCLUSIVE is never PASS, so a caller that forgets the bundle gets a
 *  refusal, never a free pass. */
export const defaultTreeEquivOracle: TreeEquivOracle = (req) => {
  if (req.hbcPath === undefined) {
    return { verdict: "INCONCLUSIVE", why: "no bundle supplied: nothing to prove tree equivalence against", oracle: "hbc2js equiv --hbc <none>", lines: 0 };
  }
  const r = hbcVsJsUnderHermes(req.hbcPath, join(req.treeDir, req.entry));
  // `hbcVsJsUnderHermes` speaks the harness vocabulary (EQUIVALENT /
  // DIVERGENT / INCONCLUSIVE); the equiv-gate contract speaks PASS. Only
  // EQUIVALENT maps to PASS -- INCONCLUSIVE is never PASS.
  return { verdict: r.verdict === "EQUIVALENT" ? "PASS" : r.verdict === "DIVERGENT" ? "DIVERGENT" : "INCONCLUSIVE", why: r.why, oracle: r.oracle, lines: r.lines };
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface MakeRequest {
  readonly op: "make";
  readonly path: string;
  readonly content: string;
  /** A new file must say where its content came from -- an output with zero
   *  origins is an orphan and the transaction is refused. */
  readonly origins: readonly BindingOrigin[];
  readonly evidence: string;
}
export interface RenameRequest {
  readonly op: "rename" | "move";
  readonly from: string;
  readonly to: string;
  readonly evidence: string;
}
export interface CombineRequest {
  readonly op: "combine";
  readonly from: readonly string[];
  readonly to: string;
  readonly evidence: string;
  /** Text between the merged bodies; defaults to a blank line. */
  readonly separator?: string;
}
export interface SplitRequest {
  readonly op: "split";
  readonly from: string;
  /** Each part's content and the subset of the source's origins it carries.
   *  Omitting `origins` inherits ALL of the source's -- correct but coarse;
   *  passing the real subset is what keeps `{fn,reg}`-level traceability
   *  through a split. */
  readonly parts: readonly { readonly path: string; readonly content: string; readonly origins?: readonly BindingOrigin[] }[];
  readonly evidence: string;
}
export type FileOpRequest = MakeRequest | RenameRequest | CombineRequest | SplitRequest;

export interface FileOpOptions {
  readonly db: DatabaseSync;
  /** The project root holding `project.hbcproj`, `analysis/` and `log/`. */
  readonly projectDir: string;
  /** The readable tree the op reshapes. */
  readonly treeDir: string;
  /** Entry file of the tree, relative to `treeDir`. Defaults to `index.js`. */
  readonly entry?: string;
  readonly hbcPath?: string;
  readonly oracle?: TreeEquivOracle;
  readonly who?: string;
  readonly ts?: string;
  /** Origins for files the log has never emitted (the faithful render the
   *  tree started as). Defaults to `MODULES.json`'s module id for the file. */
  readonly baseOrigins?: ReadonlyMap<string, readonly BindingOrigin[]>;
}

export interface FileOpAttempt {
  readonly op: FileOpKind;
  readonly accepted: boolean;
  readonly proof: EquivProof;
  /** Why it was rejected, or the oracle's PASS reason. */
  readonly detail: string;
  readonly txId?: string;
  /** The tree hash before the op; equal to the hash after it when rejected. */
  readonly priorTreeHash: string;
}

export class FileOpError extends Error {}

// ---------------------------------------------------------------------------
// Applying an op to a snapshot
// ---------------------------------------------------------------------------

interface Proposal {
  readonly next: Map<string, string>;
  readonly outputs: EmittedFile[];
  /** Paths whose prior content must be recorded for the revert. */
  readonly priorPaths: string[];
}

function originsOf(opts: FileOpOptions, snapshot: TreeSnapshot, path: string): readonly BindingOrigin[] {
  const traced = traceFile(opts.db, path);
  if (traced.origins.length > 0) return traced.origins;
  const base = opts.baseOrigins?.get(path);
  if (base !== undefined && base.length > 0) return base;
  const index = readModulesIndex(snapshot);
  const m = index.modules.find((x) => x.file === path);
  return m === undefined ? [] : [{ module: m.id }];
}

function rewriteIndex(snapshot: Map<string, string>, remap: ReadonlyMap<string, string>): void {
  const raw = snapshot.get(MODULES_JSON);
  if (raw === undefined) return;
  let parsed: ModulesIndex;
  try {
    parsed = JSON.parse(raw) as ModulesIndex;
  } catch {
    return;
  }
  if (!Array.isArray(parsed.modules)) return;
  let changed = false;
  for (const m of parsed.modules) {
    const to = remap.get(m.file);
    if (to !== undefined && to !== m.file) {
      m.file = to;
      changed = true;
    }
  }
  if (changed) snapshot.set(MODULES_JSON, `${JSON.stringify(parsed, null, 2)}\n`);
}

function propose(req: FileOpRequest, snapshot: TreeSnapshot, opts: FileOpOptions): Proposal {
  const next = new Map(snapshot);
  const priorPaths: string[] = [];
  const outputs: EmittedFile[] = [];
  const remap = new Map<string, string>();

  if (req.op === "make") {
    if (next.has(req.path)) priorPaths.push(req.path);
    next.set(req.path, req.content);
    outputs.push({ path: req.path, origins: req.origins });
  } else if (req.op === "rename" || req.op === "move") {
    const content = snapshot.get(req.from);
    if (content === undefined) throw new FileOpError(`${req.op}: ${req.from} is not in the tree`);
    if (req.op === "rename" && dirname(req.from) !== dirname(req.to)) {
      throw new FileOpError(`rename: ${req.from} -> ${req.to} changes directory; use move`);
    }
    if (req.op === "move" && dirname(req.from) === dirname(req.to)) {
      throw new FileOpError(`move: ${req.from} -> ${req.to} stays in the same directory; use rename`);
    }
    priorPaths.push(req.from);
    if (next.has(req.to)) priorPaths.push(req.to);
    next.delete(req.from);
    next.set(req.to, content);
    remap.set(req.from, req.to);
    outputs.push({ path: req.to, origins: originsOf(opts, snapshot, req.from) });
  } else if (req.op === "combine") {
    if (req.from.length < 2) throw new FileOpError("combine: needs at least two input files");
    const parts: string[] = [];
    const origins: BindingOrigin[] = [];
    for (const p of req.from) {
      const content = snapshot.get(p);
      if (content === undefined) throw new FileOpError(`combine: ${p} is not in the tree`);
      parts.push(content);
      origins.push(...originsOf(opts, snapshot, p));
      priorPaths.push(p);
      remap.set(p, req.to);
    }
    if (next.has(req.to) && !req.from.includes(req.to)) priorPaths.push(req.to);
    for (const p of req.from) next.delete(p);
    next.set(req.to, parts.join(req.separator ?? "\n\n"));
    outputs.push({ path: req.to, origins });
  } else if (req.op === "split") {
    const content = snapshot.get(req.from);
    if (content === undefined) throw new FileOpError(`split: ${req.from} is not in the tree`);
    if (req.parts.length < 2) throw new FileOpError("split: needs at least two output parts");
    const sourceOrigins = originsOf(opts, snapshot, req.from);
    priorPaths.push(req.from);
    next.delete(req.from);
    for (const part of req.parts) {
      if (next.has(part.path)) priorPaths.push(part.path);
      next.set(part.path, part.content);
      outputs.push({ path: part.path, origins: part.origins ?? sourceOrigins });
    }
    const first = req.parts[0]!.path;
    remap.set(req.from, first);
  } else {
    throw new FileOpError(`unknown file op: ${JSON.stringify(req)}`);
  }

  rewriteIndex(next, remap);
  if (next.get(MODULES_JSON) !== snapshot.get(MODULES_JSON) && snapshot.has(MODULES_JSON)) priorPaths.push(MODULES_JSON);
  return { next, outputs, priorPaths: [...new Set(priorPaths)].sort() };
}

function materialise(snapshot: TreeSnapshot, dir: string): void {
  for (const [path, content] of snapshot) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/** Runs one file op end to end: propose, stage, gate, and -- only on PASS --
 *  apply to the real tree and record the transaction. On any rejection the
 *  tree is byte-for-byte untouched and nothing is written to the DB. */
export function runFileOp(req: FileOpRequest, opts: FileOpOptions): FileOpAttempt {
  const before = readTree(opts.treeDir);
  const priorTreeHash = treeHash(before);
  const entry = opts.entry ?? "index.js";
  const ts = opts.ts ?? new Date().toISOString();
  const proposal = propose(req, before, opts);

  // Leg 1: structure. Cheap, in process, and it explains itself.
  const structureProblems: string[] = [];
  if (requireGraph(proposal.next) !== requireGraph(before)) {
    structureProblems.push("the require graph does not resolve identically after the op");
  }
  if (exportSurface(proposal.next) !== exportSurface(before)) {
    structureProblems.push("the export surface changed: an export was added or dropped");
  }

  // Leg 2: behaviour, over the STAGED tree -- the real one is not touched
  // until both legs pass.
  const staging = mkdtempSync(join(tmpdir(), "hbc2js-fileop-"));
  let oracleResult: TreeEquivResult;
  try {
    materialise(proposal.next, staging);
    oracleResult =
      structureProblems.length > 0
        ? { verdict: "DIVERGENT", why: structureProblems.join("; "), oracle: `tree-structure check over ${entry}`, lines: 0 }
        : (opts.oracle ?? defaultTreeEquivOracle)({ treeDir: staging, entry, ...(opts.hbcPath !== undefined ? { hbcPath: opts.hbcPath } : {}) });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const proof: EquivProof = {
    scope: "tree",
    verdict: oracleResult.verdict,
    oracle: oracleResult.oracle,
    coverage: { inputs: 1, records: oracleResult.lines },
    ts,
  };
  if (oracleResult.verdict !== "PASS") {
    return { op: req.op, accepted: false, proof, detail: oracleResult.why, priorTreeHash };
  }

  const inputs: BindingOrigin[] = [];
  for (const o of proposal.outputs) inputs.push(...o.origins);
  const priorFiles = proposal.priorPaths.map((p) => ({ path: p, sha256: sha256(before.get(p) ?? "") }));
  const priorContents = new Map<string, string>();
  for (const p of proposal.priorPaths) priorContents.set(p, before.get(p) ?? "");

  const tx: ReadabilityTransaction = {
    id: transactionId(req.op, inputs, proposal.outputs, req.evidence),
    op: req.op,
    who: opts.who ?? "worker:haiku",
    tier: "suggested",
    ts,
    inputs,
    outputs: proposal.outputs,
    equiv: proof,
    evidence: req.evidence,
    prior: { files: priorFiles },
  };

  // DB first (spec 18 section 6). A refusal here -- a zero-origin output, a
  // missing prior -- must leave the tree untouched, so it happens before any
  // write to `treeDir`.
  recordTransaction(opts.db, opts.projectDir, tx, { priorContents });

  for (const p of before.keys()) if (!proposal.next.has(p)) rmSync(join(opts.treeDir, p), { force: true });
  materialise(proposal.next, opts.treeDir);

  return { op: req.op, accepted: true, proof, detail: oracleResult.why, txId: tx.id, priorTreeHash };
}

/** Copies a tree (used by callers that want a pristine baseline to compare a
 *  revert against). */
export function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
