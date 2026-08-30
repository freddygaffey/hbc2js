// The M4 pipeline: bytes -> JavaScript.
//
//   parse (spec 01) -> decode (spec 02) -> CFG (spec 03) -> structure (spec 04)
//   -> emit (spec 05) -> `node --check`
//
// D11: this is the baseline. Output may be ugly — `while(true)` with `break`,
// register-named variables, `Reflect.apply` calls, duplicated `finally` bodies,
// generator shims — but it must pass the equivalence checker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "./errors.ts";
import { ErrorCode, Hbc2jsError } from "./errors.ts";
import { analyseModule } from "./cfg/index.ts";
import type { AnalysisOptions } from "./cfg/types.ts";
import { emitModule } from "./emit/index.ts";
import type { EmitOptions } from "./emit/index.ts";
import { parseHbc } from "./parse/module.ts";
import type { HbcModule, OpcodeTableId } from "./parse/types.ts";
import { printTree, structure } from "./structure/index.ts";
import { astPassHook, passHook, runPasses } from "./passes/index.ts";
import type { PassPipelineOptions } from "./passes/index.ts";
import { printProgram } from "./emit/print.ts";
import type { Stmt } from "./emit/ast.ts";

export interface DecompileOptions {
  readonly moduleName?: string;
  readonly opcodeTable?: OpcodeTableId;
  /**
   * Recover from `E_LAYOUT_AMBIGUOUS` by forcing `hbc98-late`. D8 forbids the
   * *parser* from guessing; this is the caller making the choice explicitly, and
   * it is reported in `diagnostics`. `tests/support/known-issues.ts` records the
   * external evidence for the eight v98 construct fixtures it applies to.
   */
  readonly resolveV98Ambiguity?: boolean;
  readonly analysis?: AnalysisOptions;
  readonly emit?: EmitOptions;
  /**
   * Spec 03 §6.4's R3 rule (`--lenient-env`). Default `true`: an environment
   * access the env graph cannot resolve statically refuses the whole module
   * with `E_ENV_UNRESOLVED`. `false` emits a loud `__hbc_unresolved_env(...)`
   * marker per site instead — it throws when reached, and every site is
   * reported as `W_ENV_UNRESOLVED` — so a production bundle with a handful of
   * unresolvable sites can still be read (review M4-H2).
   */
  readonly strictEnv?: boolean;
  /** Run the spec 04 §5 isomorphism check inline. Default true. */
  readonly verify?: boolean;
  /** Only emit this function's tree (`--emit-tree`, `--function`). */
  readonly functionIndex?: number;
  /**
   * Spec 07 pass pipeline. Every registered pass runs by default;
   * `{ skip: ["loop-cond"] }` is `--no-pass loop-cond`, `{ none: true }` is
   * `--passes=none` (the M4 baseline, PL-05).
   */
  readonly passes?: PassPipelineOptions;
}

export interface DecompileResult {
  readonly code: string;
  readonly module: HbcModule;
  readonly helpersUsed: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly forcedOpcodeTable: boolean;
}

export function parseForDecompile(bytes: Uint8Array, opts: DecompileOptions = {}): { readonly module: HbcModule; readonly forced: boolean } {
  if (opts.opcodeTable !== undefined) return { module: parseHbc(bytes, { opcodeTable: opts.opcodeTable }), forced: true };
  try {
    return { module: parseHbc(bytes), forced: false };
  } catch (e) {
    if (opts.resolveV98Ambiguity === true && e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS) {
      return { module: parseHbc(bytes, { opcodeTable: "hbc98-late" }), forced: true };
    }
    throw e;
  }
}

export function decompile(bytes: Uint8Array, opts: DecompileOptions = {}): DecompileResult {
  const { module, forced } = parseForDecompile(bytes, opts);
  const strictEnv = opts.strictEnv ?? true;
  const analysis = analyseModule(module, { strictEnv, ...opts.analysis });
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];
  if (forced) {
    diagnostics.push({
      severity: "warn",
      code: "W_FORCED_OPCODE_TABLE",
      message: `opcode table forced to ${module.layout.opcodeTable ?? "?"}; the auto-probe found the file ambiguous`,
      context: { section: "decompile" },
    });
  }
  const result = emitModule(analysis, {
    moduleName: opts.moduleName ?? "input.hbc",
    provenanceComments: false,
    strictEnv,
    passes: passHook(analysis, opts.passes),
    astPasses: astPassHook(analysis, opts.passes),
    ...opts.emit,
    ...(opts.verify === false ? { structure: { ...opts.emit?.structure, verify: false } } : {}),
  });
  return { code: result.code, module, helpersUsed: result.helpersUsed, diagnostics: [...diagnostics, ...result.diagnostics], forcedOpcodeTable: forced };
}

/** `--emit-tree`: the structurer's tree IR for one function (or all of them). */
export function decompileTree(bytes: Uint8Array, opts: DecompileOptions = {}): string {
  const { module } = parseForDecompile(bytes, opts);
  const analysis = analyseModule(module, { strictEnv: opts.strictEnv ?? true, ...opts.analysis });
  const indices = opts.functionIndex !== undefined ? [opts.functionIndex] : module.functions.map((_, i) => i);
  const out: string[] = [];
  for (const i of indices) {
    const cfg = analysis.cfg(i);
    const structured = structure(cfg, { verify: opts.verify !== false });
    const passed = runPasses(analysis, structured, cfg, opts.passes);
    const s = passed.fn;
    out.push(`; fn#${i} ${JSON.stringify(analysis.decoded(i).name)}  ${JSON.stringify(s.stats)}${passed.applied.length > 0 ? `  passes=${passed.applied.map((a) => `${a.pass}@${a.at.offset}`).join(",")}` : ""}${passed.abandoned.length > 0 ? `  abandoned=${passed.abandoned.map((a) => `${a.pass}@${a.at.offset}(${a.reason})`).join(",")}` : ""}`);
    out.push(printTree(s));
  }
  return out.join("\n");
}

/** F1: `--emit-ast` mirrors `--emit-tree`, one function's stage-B JS AST at a
 *  time, each with a `passes=…`/`abandoned=…` header — but *after* emission,
 *  since the JS AST only exists once `emitFunction` has run. Reuses the real
 *  `emitModule` traversal (children hoisted/inlined exactly as production
 *  does) and taps `astPasses` to capture each function's own body and report
 *  before it is spliced into its parent. */
export function decompileAst(bytes: Uint8Array, opts: DecompileOptions = {}): string {
  const { module } = parseForDecompile(bytes, opts);
  const strictEnv = opts.strictEnv ?? true;
  const analysis = analyseModule(module, { strictEnv, ...opts.analysis });
  const headers = new Map<number, string>();
  const bodies = new Map<number, Stmt>();
  const hook = astPassHook(analysis, opts.passes, (functionIndex, r) => {
    const parts: string[] = [];
    if (r.applied.length > 0) parts.push(`passes=${r.applied.map((a) => `${a.pass}@${a.at.offset}`).join(",")}`);
    if (r.abandoned.length > 0) parts.push(`abandoned=${r.abandoned.map((a) => `${a.pass}@${a.at.offset}(${a.reason})`).join(",")}`);
    headers.set(functionIndex, parts.join("  "));
  });
  emitModule(analysis, {
    moduleName: opts.moduleName ?? "input.hbc",
    provenanceComments: false,
    strictEnv,
    passes: passHook(analysis, opts.passes),
    astPasses: (fn, cfg) => {
      const out = hook(fn, cfg);
      if (out.fn.k === "func") bodies.set(cfg.functionIndex, out.fn);
      return out;
    },
    ...opts.emit,
    ...(opts.verify === false ? { structure: { ...opts.emit?.structure, verify: false } } : {}),
  });
  const indices = opts.functionIndex !== undefined ? [opts.functionIndex] : [...bodies.keys()].sort((a, b) => a - b);
  const out: string[] = [];
  for (const i of indices) {
    const body = bodies.get(i);
    if (body === undefined) continue;
    const header = headers.get(i) ?? "";
    out.push(`; fn#${i}${header.length > 0 ? `  ${header}` : ""}`);
    out.push(printProgram([body]));
  }
  return out.join("\n");
}

/** EM-02 — the cheapest gate there is, and it catches a whole bug class. */
export function nodeCheck(code: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-check-"));
  const file = join(dir, "candidate.js");
  try {
    writeFileSync(file, code);
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true };
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr;
    return { ok: false, message: stderr !== undefined ? stderr.toString().split("\n").slice(0, 6).join("\n") : String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
