// tools/e2e/roundtrip-corpus.ts — E2E tier 1: corpus-wide bytecode round-trip
// ratchet (docs/TESTING.md "E2E tier 1").
//
// For every real bundle: `--split` it into a per-module project tree, then
// per module file recompile with the SAME hermesc version as the bundle
// (`hermesc -O -emit-binary`, one process per module — a module is its
// factory function plus every nested function), decode both the original
// bundle's functions and the recompiled file's with `src/disasm`, and compare
// them one function at a time with `src/harness/roundtrip.ts`'s existing
// normalisation (`normaliseFunction`: registers renamed by first use, cache
// slots / literal offsets / generated names masked). Nothing here is a
// behaviour oracle: an IDENTICAL verdict means the decompiled source
// compiles back to the same normalised bytecode, DIFFERENT means only that
// it does not — the trace/fuzz oracles are the behaviour tier.
//
//   node tools/e2e/roundtrip-corpus.ts [--only <name,...>] [--limit N]
//        [--jobs N] [--passes on|off|both] [--out <dir>]
//        [--bundle <name>=<path.hbc>]... [--hermesc-flags "<flags>"]
//
// Verdicts per ORIGINAL function reachable from a module's factory:
//   IDENTICAL        normalised text equal
//   DIFFERENT        bucket "diff:<orig op>/<recompiled op>" = the first
//                    differing normalised line's opcodes; "tree:..." when the
//                    closure tree itself has a different shape
//   RECOMPILE-ERROR  hermesc rejected the module file; bucket = error class
//   DECOMPILE-STUB   the split emitted `emitModule`'s throwing stub for it
//                    (W_FUNCTION_STUBBED); bucket = the error code
//
// Outputs (never inside the repo — bundle-derived): `<out>/<bundle>.json`
// (per-function verdicts, both modes) and `<out>/<bundle>.md` (summary: total,
// % IDENTICAL, top-15 buckets with one example each). The committed ratchet
// lives in docs/e2e/roundtrip-baseline.json (numbers only) and is enforced by
// tests/sweep/e2e/roundtrip-ratchet.test.ts, which imports `runBundle`.
import { execFile } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { decodeFunction } from "../../src/disasm/decode.ts";
import type { DecodedFunction } from "../../src/disasm/decode.ts";
import { findHermesc, normaliseFunction } from "../../src/harness/roundtrip.ts";
import { parseHbc } from "../../src/parse/module.ts";
import type { HbcModule } from "../../src/parse/types.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { repoRoot } from "../../src/util/paths.ts";

// ---------------------------------------------------------------------------
// bundle registry
// ---------------------------------------------------------------------------

export interface BundleSpec {
  readonly name: string;
  /** Absolute path to the Hermes bytecode file. */
  readonly path: string;
  /** Committed (or fetch.sh-reproducible) under tests/fixtures/bundles — the
   *  only bundles the ratchet test gates. Local-corpus / ad-hoc bundles are
   *  measured and reported (docs/e2e/RESULTS.md), never gated. */
  readonly committed: boolean;
}

export type PassMode = "passes-off" | "passes-on";
export const PASS_MODES: readonly PassMode[] = ["passes-off", "passes-on"];

/** The bundles this harness knows about. Committed ones by fixed path; the
 *  local corpus from its MANIFEST (paths only, D16 C5 — nothing derived from
 *  those bundles is ever written into the repo). */
export function knownBundles(): readonly BundleSpec[] {
  const root = repoRoot();
  const bundles = join(root, "tests", "fixtures", "bundles");
  const out: BundleSpec[] = [
    { name: "rn-template-0.72", path: join(bundles, "rn-template-0.72", "index.android.hbc"), committed: true },
    { name: "react-navigation-example-0.85.3", path: join(bundles, "react-navigation-example-0.85.3", "react-navigation-example.hbc"), committed: true },
    { name: "expensify-app-0.86.0", path: join(bundles, "expensify-app-0.86.0", "expensify-app.hbc"), committed: true },
  ];
  const manifestPath = join(root, "tests", "fixtures", "local-corpus", "MANIFEST.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as readonly { readonly sha256: string; readonly sourceApkName: string }[];
    for (const m of manifest) {
      const dir = m.sha256.slice(0, 16);
      out.push({ name: `local-${m.sourceApkName.replace(/\.apk$/, "")}`, path: join(root, "tests", "fixtures", "local-corpus", dir, "bundle.hbc"), committed: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// result shapes
// ---------------------------------------------------------------------------

export type Verdict = "IDENTICAL" | "DIFFERENT" | "RECOMPILE-ERROR" | "DECOMPILE-STUB";

export interface FnResult {
  /** Function index in the ORIGINAL bundle. */
  readonly fn: number;
  readonly module: number;
  readonly verdict: Verdict;
  /** Short reason; "" for IDENTICAL. */
  readonly bucket: string;
  /** Function index in the recompiled module file, when one was paired. */
  readonly rfn?: number;
}

export interface BucketSummary {
  readonly bucket: string;
  readonly verdict: Verdict;
  readonly count: number;
  readonly example: { readonly module: number; readonly fn: number };
}

export interface ModeReport {
  readonly mode: PassMode;
  readonly hbcVersion: number;
  readonly hermesc: string;
  readonly hermescFlags: readonly string[];
  readonly modules: number;
  readonly modulesRun: number;
  /** Functions in the bundle (all of them, including the global function and
   *  anything outside a Metro module). */
  readonly bundleFunctions: number;
  /** Functions reachable from a measured module's factory = the denominator. */
  readonly functions: number;
  readonly identical: number;
  readonly different: number;
  readonly recompileError: number;
  readonly decompileStub: number;
  readonly identicalPct: number;
  readonly buckets: readonly BucketSummary[];
  readonly splitMs: number;
  readonly compareMs: number;
  readonly wallMs: number;
  readonly splitDiagnostics: number;
  readonly results: readonly FnResult[];
}

export interface BundleReport {
  readonly bundle: string;
  readonly path: string;
  readonly hbcVersion: number;
  readonly modes: Partial<Record<PassMode, ModeReport>>;
}

// ---------------------------------------------------------------------------
// shared: function trees + normalisation (used in workers)
// ---------------------------------------------------------------------------

/** Nested functions of `fn` in creation order: every distinct `function`
 *  operand (CreateClosure / CreateGeneratorClosure / CreateAsyncClosure and
 *  their long forms) by first appearance in the instruction stream. */
function childrenOf(fn: DecodedFunction): readonly number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const insn of fn.instructions) {
    for (const op of insn.operands) {
      if (op.role === "function" && !seen.has(op.value)) {
        seen.add(op.value);
        out.push(op.value);
      }
    }
  }
  return out;
}

class Decoder {
  private readonly cache = new Map<number, DecodedFunction | Error>();
  readonly mod: HbcModule;
  constructor(mod: HbcModule) {
    this.mod = mod;
  }
  decode(i: number): DecodedFunction | Error {
    let d = this.cache.get(i);
    if (d === undefined) {
      try {
        d = decodeFunction(this.mod, i);
      } catch (e) {
        d = e instanceof Error ? e : new Error(String(e));
      }
      this.cache.set(i, d);
    }
    return d;
  }
}

/** Every function reachable from `root` (inclusive), pre-order. */
function subtree(dec: Decoder, root: number, visited: Set<number>): number[] {
  const out: number[] = [];
  const walk = (i: number): void => {
    if (visited.has(i)) return;
    visited.add(i);
    out.push(i);
    const d = dec.decode(i);
    if (d instanceof Error) return;
    for (const c of childrenOf(d)) walk(c);
  };
  walk(root);
  return out;
}

function errorCodeOf(e: Error): string {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : "E_UNKNOWN";
}

/** The opcode (or directive) a normalised line is about, label stripped. */
function opOf(line: string | undefined): string {
  if (line === undefined) return "<end>";
  const s = line.replace(/^L\d+: /, "");
  const sp = s.indexOf(" ");
  return sp < 0 ? s : s.slice(0, sp);
}

/** Which kind of operand token differs when the opcodes agree — the class
 *  of the divergence, not its value (values would make one bucket per site). */
function operandClass(tok: string): string {
  if (tok.startsWith("%")) return "reg";
  if (tok.startsWith("s#")) return "string";
  if (tok.startsWith("f#")) return "fn";
  if (tok.startsWith("b#")) return "builtin";
  if (tok.startsWith("sh#")) return "shape";
  if (tok.startsWith("bi#")) return "bigint";
  if (/^L\d+$/.test(tok)) return "label";
  if (/^-?\d/.test(tok)) return "imm";
  return "operand";
}

/**
 * Fold an opcode's operand-width variants (`GetByIdShort`/`GetById`/
 * `GetByIdLong`, `JmpLong`, `LoadConstStringLongIndex`, ...) onto the base
 * opcode in an already-normalised function text. `src/harness/roundtrip.ts`
 * keeps them apart because fixture round-trips share one string table; here
 * the recompiled side is one module with a tiny string table, so every
 * `GetById` whose original string id was >= 256 comes back `GetByIdShort`
 * — an artifact of splitting, not of decompilation. Register/immediate
 * widths (`LoadConstUInt8` vs `LoadConstInt`, `Call1..4`) are value- or
 * arity-driven, identical on both sides, and left alone.
 */
export function foldWidthVariants(normalised: string): string {
  return normalised.replace(/^((?:L\d+: )?)([A-Za-z]+?)(?:Short|LongIndex|Long)\b/gm, "$1$2");
}

/** "diff:<op>/<op>" at the first differing normalised line; when both sides
 *  have the same opcode there, "diff:<op>(<operand class>)" instead. */
export function firstDiffBucket(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  if (al[0] !== bl[0]) return "diff:param-count";
  const n = Math.max(al.length, bl.length);
  for (let i = 1; i < n; i++) {
    if (al[i] === bl[i]) continue;
    const oa = opOf(al[i]);
    const ob = opOf(bl[i]);
    if (oa !== ob) return `diff:${oa}/${ob}`;
    const ta = al[i]!.replace(/^L\d+: /, "").split(/,? /).slice(1);
    const tb = bl[i]!.replace(/^L\d+: /, "").split(/,? /).slice(1);
    for (let k = 0; k < Math.max(ta.length, tb.length); k++) {
      if (ta[k] !== tb[k]) return `diff:${oa}(${ta[k] === undefined || tb[k] === undefined ? "arity" : operandClass(ta[k]!)})`;
    }
    return `diff:${oa}(label)`;
  }
  return "diff:?";
}

/** Side-by-side normalised texts of one (original fn, recompiled fn) pair, for
 *  `--show`: the first `context` lines around the first difference. */
export function diffExcerpt(a: string, b: string, context = 6): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  const from = Math.max(0, i - context);
  const to = Math.min(Math.max(al.length, bl.length), i + context + 1);
  const out: string[] = [`--- first difference at line ${i} (original ${al.length} lines, recompiled ${bl.length})`];
  for (let k = from; k < to; k++) {
    const mark = al[k] === bl[k] ? " " : "!";
    out.push(`${mark} ${String(k).padStart(4)}  ${(al[k] ?? "<end>").padEnd(48)} | ${bl[k] ?? "<end>"}`);
  }
  return out.join("\n");
}

/** hermesc's stderr -> a short, position-free error class. */
export function hermescErrorClass(stderr: string): string {
  const m = /error: (.+)/.exec(stderr);
  let msg = m?.[1] ?? stderr.split("\n").find((l) => l.trim().length > 0) ?? "exit";
  msg = msg
    .replace(/'[^']*'/g, "'_'")
    .replace(/"[^"]*"/g, '"_"')
    .replace(/\b\d+\b/g, "N")
    .trim();
  if (msg.length > 70) msg = msg.slice(0, 70);
  return `hermesc:${msg}`;
}

/** Stubs `emitModule` wrote for functions it could not decompile
 *  (`stubFor` in src/emit/index.ts): "hbc2js: could not decompile fn#N — E_CODE". */
export function stubbedFunctionsIn(source: string): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  const re = /could not decompile fn#(\d+) — (E_[A-Z0-9_]+)/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) out.set(Number(m[1]), m[2]!);
  return out;
}

const WHOLE_MODULE_STUB = /^\/\/ hbc2js --split -- module \d+: factory fn#\d+ was not reachable/;

function compileModule(hermesc: string, flags: readonly string[], source: string, embeddedFilename: string): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string }> {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-e2e-"));
  const srcPath = join(dir, embeddedFilename);
  const outPath = join(dir, "out.hbc");
  writeFileSync(srcPath, source);
  return new Promise((resolve) => {
    execFile(hermesc, [...flags, "-emit-binary", `-out=${outPath}`, embeddedFilename], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      try {
        if (err !== null) resolve({ ok: false, error: stderr.length > 0 ? stderr : String(err) });
        else resolve({ ok: true, bytes: new Uint8Array(readFileSync(outPath)) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

interface WorkerInit {
  readonly bundlePath: string;
  readonly hermesc: string;
  readonly hermescFlags: readonly string[];
  readonly splitDir: string;
}

interface Task {
  readonly module: number;
  readonly file: string;
  readonly factoryFunctionIndex: number;
  /** `--show`: also return the normalised diff excerpt for this original fn. */
  readonly showFn?: number;
}

interface TaskResult {
  readonly module: number;
  readonly results: readonly FnResult[];
  readonly excerpt?: string;
}

/** Compare one module: original factory subtree vs the recompiled file. */
async function compareModule(init: WorkerInit, orig: Decoder, task: Task): Promise<TaskResult> {
  const results: FnResult[] = [];
  const tree = subtree(orig, task.factoryFunctionIndex, new Set());
  const push = (fn: number, verdict: Verdict, bucket: string, rfn?: number): void => {
    results.push(rfn === undefined ? { fn, module: task.module, verdict, bucket } : { fn, module: task.module, verdict, bucket, rfn });
  };
  const all = (verdict: Verdict, bucket: string): TaskResult => {
    for (const fn of tree) push(fn, verdict, bucket);
    return { module: task.module, results };
  };

  const source = readFileSync(join(init.splitDir, task.file), "utf8");
  if (WHOLE_MODULE_STUB.test(source)) return all("DECOMPILE-STUB", "stub:factory-not-reachable");
  const stubs = stubbedFunctionsIn(source);

  const compiled = await compileModule(init.hermesc, init.hermescFlags, source, task.file);
  if (!compiled.ok) {
    const bucket = hermescErrorClass(compiled.error);
    for (const fn of tree) {
      const stub = stubs.get(fn);
      if (stub !== undefined) push(fn, "DECOMPILE-STUB", `stub:${stub}`);
      else push(fn, "RECOMPILE-ERROR", bucket);
    }
    return { module: task.module, results };
  }

  let rec: Decoder;
  try {
    rec = new Decoder(parseHbc(compiled.bytes));
  } catch (e) {
    return all("RECOMPILE-ERROR", `parse-recompiled:${e instanceof Error ? errorCodeOf(e) : "?"}`);
  }
  const rglobal = rec.decode(rec.mod.header.globalCodeIndex);
  if (rglobal instanceof Error) return all("RECOMPILE-ERROR", `decode-recompiled:${errorCodeOf(rglobal)}`);
  const top = childrenOf(rglobal);
  if (top.length !== 1) return all("DIFFERENT", `tree:recompiled-top-level-closures=${top.length}`);

  const visited = new Set<number>();
  let excerpt: string | undefined;
  const pair = (oi: number, ri: number): void => {
    if (visited.has(oi)) return;
    visited.add(oi);
    const stub = stubs.get(oi);
    const od = orig.decode(oi);
    const rd = rec.decode(ri);
    if (stub !== undefined) push(oi, "DECOMPILE-STUB", `stub:${stub}`, ri);
    else if (od instanceof Error) push(oi, "DIFFERENT", `decode-original:${errorCodeOf(od)}`, ri);
    else if (rd instanceof Error) push(oi, "DIFFERENT", `decode-recompiled:${errorCodeOf(rd)}`, ri);
    else {
      const a = foldWidthVariants(normaliseFunction(orig.mod, od));
      const b = foldWidthVariants(normaliseFunction(rec.mod, rd));
      if (a === b) push(oi, "IDENTICAL", "", ri);
      else push(oi, "DIFFERENT", firstDiffBucket(a, b), ri);
      if (oi === task.showFn) excerpt = `original fn#${oi} <-> recompiled fn#${ri}\n${diffExcerpt(a, b)}`;
    }
    if (od instanceof Error || rd instanceof Error) {
      if (!(od instanceof Error)) for (const c of subtree(orig, oi, new Set(visited)).slice(1)) push(c, "DIFFERENT", "tree:parent-undecodable"), visited.add(c);
      return;
    }
    const oc = childrenOf(od);
    const rc = childrenOf(rd);
    // Pair nested functions by NAME first: the split names every nested
    // function after its original index (`_fn388`) and hermesc keeps
    // declaration names, so this survives the decompiler hoisting
    // declarations to the top of the parent (which reorders CreateClosure
    // relative to the original's use order). Whatever is left on both
    // sides (renamed by fn-naming, or a function expression) pairs by
    // position; leftover originals are the closures the recompile lost.
    const byName = new Map<number, number>();
    const unusedR = new Set<number>(rc);
    const origByName = new Map<string, number[]>();
    for (const o of oc) {
      const nm = orig.mod.functions[o]?.name ?? "";
      if (nm.length > 0) origByName.set(nm, [...(origByName.get(nm) ?? []), o]);
    }
    for (const ri of rc) {
      const rn = rec.mod.functions[ri]?.name ?? "";
      const m = /^_fn(\d+)$/.exec(rn);
      // `_fnNNN` is the split's own name for original fn#NNN; otherwise
      // fn-naming (passes on) restored the bytecode's original name, which
      // pairs when it is unique among the siblings.
      const candidates = m !== null ? [Number(m[1])] : (origByName.get(rn) ?? []);
      const oi = candidates.length === 1 ? candidates[0]! : NaN;
      if (Number.isInteger(oi) && oc.includes(oi) && !byName.has(oi)) {
        byName.set(oi, ri);
        unusedR.delete(ri);
      }
    }
    const leftoverO = oc.filter((o) => !byName.has(o));
    const leftoverR = [...unusedR];
    for (const o of oc) {
      const r = byName.get(o);
      if (r !== undefined) pair(o, r);
    }
    const n = Math.min(leftoverO.length, leftoverR.length);
    for (let k = 0; k < n; k++) pair(leftoverO[k]!, leftoverR[k]!);
    for (let k = n; k < leftoverO.length; k++) {
      for (const c of subtree(orig, leftoverO[k]!, new Set(visited))) {
        visited.add(c);
        push(c, "DIFFERENT", `tree:unmatched-closure(orig ${oc.length} vs recompiled ${rc.length})`);
      }
    }
  };
  pair(task.factoryFunctionIndex, top[0]!);
  // Anything in the original subtree the pairing never reached (a cycle
  // guard tripped, say) is still accounted for — no function goes uncounted.
  for (const fn of tree) if (!visited.has(fn)) push(fn, "DIFFERENT", "tree:unreached");
  return excerpt === undefined ? { module: task.module, results } : { module: task.module, results, excerpt };
}

/** `--show <module>:<fn>`: re-run one module of an existing split tree (from
 *  a previous run's `<out>/split/<bundle>/<mode>/`) and print the verdicts
 *  plus the normalised diff excerpt for one function. */
export async function showPair(spec: BundleSpec, mode: PassMode, outDir: string, moduleId: number, fn: number, hermescFlags: readonly string[] = ["-O"]): Promise<string> {
  const splitDir = join(outDir, "split", spec.name, mode);
  const modulesJson = join(splitDir, "MODULES.json");
  if (!existsSync(modulesJson)) throw new Error(`${modulesJson} not found — run the harness on ${spec.name}/${mode} first`);
  const modules = (JSON.parse(readFileSync(modulesJson, "utf8")) as { readonly modules: readonly { readonly id: number; readonly file: string; readonly factoryFunctionIndex: number }[] }).modules;
  const m = modules.find((x) => x.id === moduleId);
  if (m === undefined) throw new Error(`module ${moduleId} is not in ${modulesJson}`);
  const orig = new Decoder(parseHbc(new Uint8Array(readFileSync(spec.path))));
  const hermesc = findHermesc(orig.mod.header.version);
  if (hermesc === null) throw new Error(`no hermesc for v${orig.mod.header.version}`);
  const r = await compareModule({ bundlePath: spec.path, hermesc: hermesc.path, hermescFlags, splitDir }, orig, { module: m.id, file: m.file, factoryFunctionIndex: m.factoryFunctionIndex, showFn: fn });
  const lines = r.results.map((x) => `fn#${x.fn}${x.rfn !== undefined ? ` (recompiled fn#${x.rfn})` : ""}: ${x.verdict}${x.bucket.length > 0 ? ` ${x.bucket}` : ""}`);
  return `${join(splitDir, m.file)}\n${lines.join("\n")}\n${r.excerpt ?? `(fn#${fn} was not paired in this module)`}`;
}

// ---------------------------------------------------------------------------
// worker entry
// ---------------------------------------------------------------------------

if (!isMainThread && parentPort !== null) {
  const init = workerData as WorkerInit;
  const orig = new Decoder(parseHbc(new Uint8Array(readFileSync(init.bundlePath))));
  const port = parentPort;
  port.on("message", (task: Task | null) => {
    if (task === null) {
      port.close();
      return;
    }
    compareModule(init, orig, task)
      .then((r) => port.postMessage(r))
      .catch((e: unknown) => {
        const tree = subtree(orig, task.factoryFunctionIndex, new Set());
        const bucket = `harness:${e instanceof Error ? e.message.slice(0, 60) : String(e)}`;
        port.postMessage({ module: task.module, results: tree.map((fn) => ({ fn, module: task.module, verdict: "DIFFERENT", bucket })) } satisfies TaskResult);
      });
  });
}

// ---------------------------------------------------------------------------
// main: split, fan out, aggregate
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly mode: PassMode;
  readonly outDir: string;
  readonly jobs?: number;
  readonly limit?: number;
  readonly hermescFlags?: readonly string[];
  readonly log?: (line: string) => void;
}

function summariseBuckets(results: readonly FnResult[]): BucketSummary[] {
  const map = new Map<string, { verdict: Verdict; count: number; example: { module: number; fn: number } }>();
  for (const r of results) {
    if (r.verdict === "IDENTICAL") continue;
    const cur = map.get(r.bucket);
    if (cur === undefined) map.set(r.bucket, { verdict: r.verdict, count: 1, example: { module: r.module, fn: r.fn } });
    else cur.count++;
  }
  return [...map.entries()].map(([bucket, v]) => ({ bucket, ...v })).sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
}

export async function runBundle(spec: BundleSpec, opts: RunOptions): Promise<ModeReport> {
  const log = opts.log ?? ((l: string): void => void process.stderr.write(`${l}\n`));
  const t0 = performance.now();
  const bytes = new Uint8Array(readFileSync(spec.path));
  const mod = parseHbc(bytes);
  const version = mod.header.version;
  const hermesc = findHermesc(version);
  if (hermesc === null) throw new Error(`no hermesc for HBC v${version} (tools/get-hermesc.sh ${version})`);
  const hermescFlags = opts.hermescFlags ?? ["-O"];

  const splitDir = join(opts.outDir, "split", spec.name, opts.mode);
  rmSync(splitDir, { recursive: true, force: true });
  const ts = performance.now();
  const split = splitProject(bytes, { moduleName: basename(spec.path), ...(opts.mode === "passes-on" ? { passes: {} } : {}) });
  writeSplitResult(split, splitDir);
  const splitMs = performance.now() - ts;
  log(`[${spec.name}/${opts.mode}] split: ${split.modules.length} modules, ${split.diagnostics.length} diagnostic(s), ${(splitMs / 1000).toFixed(1)} s`);

  const tasks: Task[] = split.modules.map((m) => ({ module: m.id, file: m.file, factoryFunctionIndex: m.factoryFunctionIndex }));
  const selected = opts.limit !== undefined ? tasks.slice(0, opts.limit) : tasks;
  const jobs = Math.max(1, Math.min(opts.jobs ?? Math.max(1, cpus().length - 1), selected.length));
  const init: WorkerInit = { bundlePath: spec.path, hermesc: hermesc.path, hermescFlags, splitDir };

  const tc = performance.now();
  const results: FnResult[] = [];
  let next = 0;
  let done = 0;
  await new Promise<void>((resolve, reject) => {
    let open = 0;
    for (let w = 0; w < jobs; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: init });
      open++;
      const feed = (): void => {
        if (next < selected.length) worker.postMessage(selected[next++]);
        else worker.postMessage(null);
      };
      worker.on("message", (r: TaskResult) => {
        results.push(...r.results);
        done++;
        if (done % 500 === 0 || done === selected.length) log(`[${spec.name}/${opts.mode}] ${done}/${selected.length} modules, ${results.length} functions, ${((performance.now() - tc) / 1000).toFixed(0)} s`);
        feed();
      });
      worker.on("error", reject);
      worker.on("exit", () => {
        open--;
        if (open === 0) resolve();
      });
      feed();
    }
  });
  const compareMs = performance.now() - tc;

  results.sort((a, b) => a.module - b.module || a.fn - b.fn);
  const count = (v: Verdict): number => results.reduce((n, r) => n + (r.verdict === v ? 1 : 0), 0);
  const identical = count("IDENTICAL");
  const report: ModeReport = {
    mode: opts.mode,
    hbcVersion: version,
    hermesc: hermesc.path,
    hermescFlags,
    modules: split.modules.length,
    modulesRun: selected.length,
    bundleFunctions: mod.functions.length,
    functions: results.length,
    identical,
    different: count("DIFFERENT"),
    recompileError: count("RECOMPILE-ERROR"),
    decompileStub: count("DECOMPILE-STUB"),
    identicalPct: results.length === 0 ? 0 : Math.round((identical / results.length) * 10000) / 100,
    buckets: summariseBuckets(results),
    splitMs: Math.round(splitMs),
    compareMs: Math.round(compareMs),
    wallMs: Math.round(performance.now() - t0),
    splitDiagnostics: split.diagnostics.length,
    results,
  };
  return report;
}

export function markdownSummary(bundle: string, r: ModeReport, top = 15): string {
  const lines: string[] = [];
  lines.push(`## ${bundle} — ${r.mode} (HBC v${r.hbcVersion}, hermesc ${r.hermescFlags.join(" ")})`);
  lines.push("");
  lines.push(`- modules: ${r.modulesRun}/${r.modules}; functions measured: ${r.functions} of ${r.bundleFunctions} in the bundle`);
  lines.push(`- IDENTICAL ${r.identical} (**${r.identicalPct.toFixed(2)}%**), DIFFERENT ${r.different}, RECOMPILE-ERROR ${r.recompileError}, DECOMPILE-STUB ${r.decompileStub}`);
  lines.push(`- wall ${(r.wallMs / 1000).toFixed(1)} s (split ${(r.splitMs / 1000).toFixed(1)} s, recompile+compare ${(r.compareMs / 1000).toFixed(1)} s); split diagnostics: ${r.splitDiagnostics}`);
  lines.push("");
  lines.push("| # | bucket | verdict | functions | example (module, fn) |");
  lines.push("|---|---|---|---|---|");
  r.buckets.slice(0, top).forEach((b, i) => {
    lines.push(`| ${i + 1} | \`${b.bucket}\` | ${b.verdict} | ${b.count} | module_${b.example.module}, fn#${b.example.fn} |`);
  });
  if (r.buckets.length > top) lines.push(`| … | ${r.buckets.length - top} more bucket(s) | | ${r.buckets.slice(top).reduce((n, b) => n + b.count, 0)} | |`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly only: readonly string[] | undefined;
  readonly limit: number | undefined;
  readonly jobs: number | undefined;
  readonly passes: "on" | "off" | "both";
  readonly outDir: string;
  readonly extra: readonly BundleSpec[];
  readonly hermescFlags: readonly string[] | undefined;
  readonly show: { readonly module: number; readonly fn: number } | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let only: string[] | undefined;
  let limit: number | undefined;
  let jobs: number | undefined;
  let passes: "on" | "off" | "both" = "both";
  let outDir = process.env["HBC2JS_E2E_OUT"] ?? join(tmpdir(), "hbc2js-e2e-corpus");
  let hermescFlags: string[] | undefined;
  let show: { module: number; fn: number } | undefined;
  const extra: BundleSpec[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--only") only = String(argv[++i]).split(",").filter((s) => s.length > 0);
    else if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--jobs") jobs = Number(argv[++i]);
    else if (a === "--passes") passes = String(argv[++i]) as "on" | "off" | "both";
    else if (a === "--out") outDir = String(argv[++i]);
    else if (a === "--hermesc-flags") hermescFlags = String(argv[++i]).split(/\s+/).filter((s) => s.length > 0);
    else if (a === "--show") {
      const [m, f] = String(argv[++i]).split(":").map(Number);
      if (m === undefined || f === undefined || !Number.isInteger(m) || !Number.isInteger(f)) throw new Error("--show expects <module>:<fn>");
      show = { module: m, fn: f };
    }
    else if (a === "--bundle") {
      const [name, path] = String(argv[++i]).split("=");
      if (name === undefined || path === undefined) throw new Error("--bundle expects <name>=<path.hbc>");
      extra.push({ name, path, committed: false });
    } else throw new Error(`unknown argument ${a}`);
  }
  return { only, limit, jobs, passes, outDir, extra, hermescFlags, show };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const all = [...knownBundles(), ...args.extra];
  const selected = all.filter((b) => (args.only === undefined || args.only.includes(b.name)) && existsSync(b.path));
  const missing = all.filter((b) => args.only?.includes(b.name) === true && !existsSync(b.path));
  for (const b of missing) process.stderr.write(`skip ${b.name}: ${b.path} not present\n`);
  mkdirSync(args.outDir, { recursive: true });
  const modes: PassMode[] = args.passes === "both" ? [...PASS_MODES] : args.passes === "on" ? ["passes-on"] : ["passes-off"];
  if (args.show !== undefined) {
    const b = selected[0];
    if (b === undefined || selected.length !== 1 || modes.length !== 1) throw new Error("--show needs exactly one --only <bundle> and --passes on|off");
    process.stdout.write(`${await showPair(b, modes[0]!, args.outDir, args.show.module, args.show.fn, args.hermescFlags ?? ["-O"])}\n`);
    return;
  }
  const rows: string[] = [];
  for (const b of selected) {
    const jsonPath = join(args.outDir, `${b.name}.json`);
    const existing: BundleReport | null = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, "utf8")) as BundleReport) : null;
    const modeReports: Partial<Record<PassMode, ModeReport>> = { ...(existing?.modes ?? {}) };
    let version = existing?.hbcVersion ?? 0;
    for (const mode of modes) {
      const r = await runBundle(b, { mode, outDir: args.outDir, ...(args.jobs !== undefined ? { jobs: args.jobs } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.hermescFlags !== undefined ? { hermescFlags: args.hermescFlags } : {}) });
      modeReports[mode] = r;
      version = r.hbcVersion;
      process.stdout.write(markdownSummary(b.name, r) + "\n");
      rows.push(`| ${b.name} | v${r.hbcVersion} | ${mode} | ${r.modulesRun}/${r.modules} | ${r.functions} | ${r.identicalPct.toFixed(2)}% | ${r.different} | ${r.recompileError} | ${r.decompileStub} | ${(r.wallMs / 1000).toFixed(0)} s |`);
    }
    const report: BundleReport = { bundle: b.name, path: b.path, hbcVersion: version, modes: modeReports };
    writeFileSync(jsonPath, JSON.stringify(report));
    const md = Object.values(modeReports)
      .map((r) => markdownSummary(b.name, r))
      .join("\n");
    writeFileSync(join(args.outDir, `${b.name}.md`), `# E2E tier 1 round-trip — ${b.name}\n\n${md}`);
  }
  process.stdout.write("\n| bundle | HBC | mode | modules | functions | IDENTICAL | DIFFERENT | RECOMPILE-ERROR | DECOMPILE-STUB | wall |\n|---|---|---|---|---|---|---|---|---|---|\n");
  for (const row of rows) process.stdout.write(`${row}\n`);
}

if (isMainThread && process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`roundtrip-corpus: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
