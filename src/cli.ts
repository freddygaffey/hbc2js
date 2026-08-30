#!/usr/bin/env node
// docs/specs/00-project-skeleton.md §6.3 — the only place in the codebase allowed to
// touch stdout/stderr or call process.exit.
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { ErrorCode, Hbc2jsError } from "./errors.ts";
import { parseHbc } from "./parse/module.ts";
import type { LayoutClass, OpcodeTableId } from "./parse/types.ts";
import { printModule } from "./disasm/print.ts";
import type { DisasmMode } from "./disasm/print.ts";
import { basename } from "node:path";
import { VERSION } from "./version.ts";
import { runProgram } from "./harness/runner.ts";
import type { RunOptions } from "./harness/runner.ts";
import { compareTraces, TRACE_VERDICT } from "./harness/compare.ts";
import { hbcVersion, findHermesVm, runHermes, findAllHermesVms } from "./harness/hermes-vm.ts";
import { normaliseModule, diffNormalised } from "./harness/roundtrip.ts";
import { runTier } from "./harness/tiers.ts";
import type { Tier } from "./harness/tiers.ts";
import { VERDICT } from "./harness/ladder.ts";

const USAGE = `hbc2js ${VERSION} — Hermes bytecode (HBC) -> JavaScript decompiler

Usage:
  hbc2js --info <input.hbc>        print header/layout/section info and exit
  hbc2js disasm <input.hbc> [options]   disassemble to text (spec 02)
  hbc2js equiv <a.js> <b.js>       execution-trace equivalence (spec 06)
  hbc2js equiv --hbc <a.hbc> <b.js>     bytecode (Hermes VM) vs decompiled JS
  hbc2js equiv normalise <a.hbc> <b.hbc>  normalised-disassembly diff (D3)
  hbc2js gate [options]            run the gate tier (spec 06 §7)
  hbc2js sweep [options]           run the sweep tier (spec 06 §7)
  hbc2js --help                    print this message
  hbc2js --version                 print the version

Options (--info):
  --layout=<A|B|C|D|E>             force a layout class instead of probing
  --opcode-table=<id>              force an opcode table instead of probing
  --verify                         exhaustively probe + verify the footer SHA-1
  --json                           emit machine-readable JSON instead of text

Options (disasm):
  --mode=raw|canonical             output format (default: canonical)
  --function=N                     disassemble only function index N
  --no-cache-indices                omit inline-cache index annotations
  -o <file>                        write to a file instead of stdout

Options (equiv):
  --hbc                     first file is bytecode; run under a matching Hermes VM
  --timeout <ms>            wall-clock budget per program (default 5000)
  --seed <n>                PRNG seed for Math.random and fuzzing (default 0)
  --fuzz[=<n>]              differential function fuzzing, <n> tuples (default 50)
  --relax <list>            fn-names,key-order,error-messages (default fn-names)
  --json                    machine-readable result on stdout
  exit 0 PASS  1 DIVERGENT  2 INCONCLUSIVE  3 harness error

Options (gate, sweep):
  --json                    machine-readable TierReport on stdout
  --only <names>            comma-separated fixture names to restrict to
  --versions <list>         comma-separated HBC versions to restrict to
  exit 0 all PASS  1 any DIVERGENT/ERROR  2 any INCONCLUSIVE only
`;

interface ParsedArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly info: string | undefined;
  readonly layout: LayoutClass | undefined;
  readonly opcodeTable: OpcodeTableId | undefined;
  readonly verify: boolean;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let version = false;
  let info: string | undefined;
  let layout: LayoutClass | undefined;
  let opcodeTable: OpcodeTableId | undefined;
  let verify = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") version = true;
    else if (a === "--info") info = argv[++i];
    else if (a.startsWith("--layout=")) layout = a.slice("--layout=".length) as LayoutClass;
    else if (a.startsWith("--opcode-table=")) opcodeTable = a.slice("--opcode-table=".length) as OpcodeTableId;
    else if (a === "--verify") verify = true;
    else if (a === "--json") json = true;
    else if (info === undefined && !a.startsWith("-")) info = a;
  }
  return { help, version, info, layout, opcodeTable, verify, json };
}

function fail(code: ErrorCode, message: string, exitCode: number, json: boolean): never {
  if (json) {
    process.stdout.write(JSON.stringify({ code, message }) + "\n");
  } else {
    process.stderr.write(`hbc2js: ${code}: ${message}\n`);
  }
  process.exit(exitCode);
}

/** Exit code for a thrown `Hbc2jsError`, per spec 00 §6.3. */
function exitCodeFor(code: ErrorCode): number {
  return code === ErrorCode.E_UNSUPPORTED_VERSION || code === ErrorCode.E_LAYOUT_AMBIGUOUS || code === ErrorCode.E_LAYOUT_NO_CANDIDATE ? 4 : 3;
}

interface DisasmArgs {
  readonly help: boolean;
  readonly input: string | undefined;
  readonly mode: DisasmMode;
  readonly functionIndex: number | undefined;
  readonly showCacheIndices: boolean;
  readonly outPath: string | undefined;
}

function parseDisasmArgs(argv: readonly string[]): DisasmArgs {
  let help = false;
  let input: string | undefined;
  let mode: DisasmMode = "canonical";
  let functionIndex: number | undefined;
  let showCacheIndices = true;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "-o") outPath = argv[++i];
    else if (a.startsWith("--mode=")) mode = a.slice("--mode=".length) as DisasmMode;
    else if (a.startsWith("--function=")) functionIndex = Number(a.slice("--function=".length));
    else if (a === "--no-cache-indices") showCacheIndices = false;
    else if (input === undefined && !a.startsWith("-")) input = a;
  }
  return { help, input, mode, functionIndex, showCacheIndices, outPath };
}

/** `hbc2js disasm <input.hbc> [options]` — spec 02 §6.3. */
function runDisasm(argv: readonly string[]): void {
  const args = parseDisasmArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.input === undefined) {
    fail(ErrorCode.E_USAGE, "disasm: no input file given (try --help)", 2, false);
  }
  if (args.mode !== "raw" && args.mode !== "canonical") {
    fail(ErrorCode.E_USAGE, `disasm: --mode must be "raw" or "canonical", got ${JSON.stringify(args.mode)}`, 2, false);
  }
  if (args.functionIndex !== undefined && !Number.isInteger(args.functionIndex)) {
    fail(ErrorCode.E_USAGE, `disasm: --function must be an integer`, 2, false);
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(args.input);
  } catch (e) {
    fail(ErrorCode.E_IO, `cannot read ${args.input}: ${e instanceof Error ? e.message : String(e)}`, 2, false);
  }

  let fd: number | undefined;
  try {
    const module = parseHbc(bytes);
    const out: NodeJS.WritableStream =
      args.outPath !== undefined
        ? ((): NodeJS.WritableStream => {
            fd = openSync(args.outPath!, "w");
            const openFd = fd;
            return { write: (chunk: string): boolean => (writeSync(openFd, chunk), true) } as NodeJS.WritableStream;
          })()
        : process.stdout;
    printModule(module, out, {
      mode: args.mode,
      showCacheIndices: args.showCacheIndices,
      moduleName: basename(args.input),
      ...(args.functionIndex !== undefined ? { indices: [args.functionIndex] } : {}),
    });
    if (fd !== undefined) closeSync(fd);
    process.exit(0);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (e instanceof Hbc2jsError) fail(e.code, e.message, exitCodeFor(e.code), false);
    fail(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e), 1, false);
  }
}

// ---------------------------------------------------------------------------
// `hbc2js equiv` — docs/specs/06-harness.md §8 (additive; folded into the main
// CLI rather than a separate `hbc2js-equiv` binary per this milestone's task
// boundary).
// ---------------------------------------------------------------------------

interface EquivArgs {
  readonly help: boolean;
  readonly hbc: boolean;
  readonly json: boolean;
  readonly timeout: number;
  readonly seed: number;
  readonly fuzz: number;
  readonly relax: readonly string[];
  readonly positional: string[];
}

function parseEquivArgs(argv: readonly string[]): EquivArgs {
  let help = false;
  let hbc = false;
  let json = false;
  let timeout = 5000;
  let seed = 0;
  let fuzz = 0;
  let relax: string[] = ["fn-names"];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--hbc") hbc = true;
    else if (a === "--json") json = true;
    else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--fuzz") fuzz = 50;
    else if (a.startsWith("--fuzz=")) fuzz = Number(a.slice("--fuzz=".length));
    else if (a === "--relax") relax = String(argv[++i]).split(",").filter((s) => s.length > 0);
    else positional.push(a);
  }
  return { help, hbc, json, timeout, seed, fuzz, relax, positional };
}

function equivCode(v: string): number {
  return v === TRACE_VERDICT.EQUIVALENT || v === VERDICT.PASS ? 0 : v === TRACE_VERDICT.DIVERGENT || v === VERDICT.DIVERGENT ? 1 : 2;
}

function runEquivNormalise(a: string, b: string, json: boolean): number {
  let bytesA: Uint8Array;
  let bytesB: Uint8Array;
  try {
    bytesA = readFileSync(a);
    bytesB = readFileSync(b);
  } catch (e) {
    process.stderr.write(`hbc2js equiv normalise: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
  try {
    const na = normaliseModule(parseHbc(bytesA));
    const nb = normaliseModule(parseHbc(bytesB));
    const d = diffNormalised(na, nb);
    if (json) {
      process.stdout.write(JSON.stringify(d, null, 2) + "\n");
    } else if (d.equal) {
      process.stdout.write(`EQUIVALENT (normalised disassembly identical, ${na.length} functions)\n`);
    } else if (d.firstDivergence !== null) {
      process.stdout.write(`DIVERGENT (similarity ${(d.similarity * 100).toFixed(1)}%)\n  first difference at function ${d.firstDivergence.fn}:\n    - ${d.firstDivergence.a}\n    + ${d.firstDivergence.b}\n`);
    }
    return d.equal ? 0 : 1;
  } catch (e) {
    process.stderr.write(`hbc2js equiv normalise: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
}

function runEquivHermes(a: string, b: string, o: EquivArgs): number {
  const version = hbcVersion(a);
  const vm = findHermesVm(version);
  if (vm === null) {
    const have = findAllHermesVms()
      .map((h) => `v${h.hbcVersion}`)
      .join(", ");
    const why = `no Hermes VM for HBC version ${version}; available: ${have === "" ? "none" : have}. The Hermes VM refuses bytecode whose version is not exactly its own (HA-05: never falls back to Node).`;
    process.stdout.write(o.json ? JSON.stringify({ verdict: TRACE_VERDICT.INCONCLUSIVE, why }, null, 2) + "\n" : `INCONCLUSIVE — ${why}\n`);
    return 2;
  }
  const ra = runHermes(vm.path, a, { timeout: o.timeout, bytecode: true });
  const rb = runHermes(vm.path, b, { timeout: o.timeout, bytecode: false });
  let i = 0;
  const n = Math.min(ra.lines.length, rb.lines.length);
  while (i < n && ra.lines[i] === rb.lines[i]) i++;
  const equal = ra.lines.length === rb.lines.length && i === ra.lines.length;
  const verdict = equal ? (ra.lines.length > 0 ? TRACE_VERDICT.EQUIVALENT : TRACE_VERDICT.INCONCLUSIVE) : TRACE_VERDICT.DIVERGENT;
  const why = equal ? (ra.lines.length > 0 ? `${ra.lines.length} output lines matched under Hermes v${version}` : "both programs produced no output; nothing was observed") : `output diverges at line ${i + 1}`;
  if (o.json) process.stdout.write(JSON.stringify({ verdict, why, a, b }, null, 2) + "\n");
  else process.stdout.write(`${verdict} — ${why}\n`);
  return equivCode(verdict);
}

async function runEquiv(argv: readonly string[]): Promise<number> {
  const o = parseEquivArgs(argv);
  if (o.help || o.positional.length === 0) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 3;
  }
  if (o.positional[0] === "normalise") {
    const [, a, b] = o.positional;
    if (a === undefined || b === undefined) {
      process.stderr.write("equiv normalise needs two .hbc files\n");
      return 3;
    }
    return runEquivNormalise(a, b, o.json);
  }
  const [a, b] = o.positional;
  if (a === undefined || b === undefined) {
    process.stderr.write(`equiv needs two files\n\n${USAGE}`);
    return 3;
  }
  if (o.hbc || a.endsWith(".hbc")) return runEquivHermes(a, b, o);

  const runOpts: RunOptions = { seed: o.seed, timeout: o.timeout, syncTimeout: Math.max(100, o.timeout - 500), fuzz: o.fuzz, relax: o.relax, maxRecords: 20000 };
  const [ta, tb] = await Promise.all([runProgram(a, runOpts), runProgram(b, runOpts)]);
  const cmp = compareTraces(ta, tb);
  if (o.json) {
    process.stdout.write(JSON.stringify({ verdict: cmp.verdict, why: cmp.why, a, b, evidence: cmp.evidence, records: cmp.records, divergence: cmp.divergence }, null, 2) + "\n");
  } else {
    process.stdout.write(`${cmp.verdict} — ${cmp.why}\n`);
    if (cmp.divergence !== null && cmp.context !== null) process.stdout.write(`\n  a = ${a}\n  b = ${b}\n\n${cmp.context}\n`);
  }
  return equivCode(cmp.verdict);
}

// ---------------------------------------------------------------------------
// `hbc2js gate` / `hbc2js sweep` — docs/specs/06-harness.md §7, §9.
// ---------------------------------------------------------------------------

interface TierArgs {
  readonly json: boolean;
  readonly only: string[] | undefined;
  readonly versions: number[] | undefined;
}

function parseTierArgs(argv: readonly string[]): TierArgs {
  let json = false;
  let only: string[] | undefined;
  let versions: number[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--only") only = String(argv[++i]).split(",").filter((s) => s.length > 0);
    else if (a === "--versions") versions = String(argv[++i])
        .split(",")
        .filter((s) => s.length > 0)
        .map(Number);
  }
  return { json, only, versions };
}

async function runTierCmd(tier: Tier, argv: readonly string[]): Promise<number> {
  const o = parseTierArgs(argv);
  const report = await runTier({ tier, ...(o.only !== undefined ? { only: o.only } : {}), ...(o.versions !== undefined ? { versions: o.versions } : {}) });
  if (o.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${tier}: ${report.summary.pass} PASS, ${report.summary.divergent} DIVERGENT, ${report.summary.inconclusive} INCONCLUSIVE, ${report.summary.error} ERROR (${report.results.length} checked, ${report.skippedByDesign.length} skipped-by-design)\n`);
    for (const r of report.results) {
      if (r.verdict !== VERDICT.PASS) {
        process.stdout.write(`  ${r.verdict.padEnd(12)} ${r.fixture.name}: ${r.oracles.map((x) => `${x.oracle}=${x.verdict}${x.detail !== undefined ? ` (${x.detail})` : ""}`).join("; ")}\n`);
      }
    }
    const caveatCount = report.results.reduce((n, r) => n + r.caveats.length, 0);
    if (caveatCount > 0) process.stdout.write(`  (${caveatCount} PASS-with-caveat — see docs/DECISIONS.md D14)\n`);
  }
  return report.summary.divergent + report.summary.error > 0 ? 1 : report.summary.inconclusive > 0 ? 2 : 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "disasm") {
    runDisasm(argv.slice(1));
    return;
  }
  if (argv[0] === "equiv") {
    void runEquiv(argv.slice(1)).then((code) => process.exit(code));
    return;
  }
  if (argv[0] === "gate" || argv[0] === "sweep") {
    void runTierCmd(argv[0], argv.slice(1)).then((code) => process.exit(code));
    return;
  }
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (args.info === undefined) {
    fail(ErrorCode.E_USAGE, "no input file given (try --help)", 2, args.json);
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(args.info);
  } catch (e) {
    fail(ErrorCode.E_IO, `cannot read ${args.info}: ${e instanceof Error ? e.message : String(e)}`, 2, args.json);
  }

  try {
    const module = parseHbc(bytes, {
      ...(args.layout !== undefined ? { layout: args.layout } : {}),
      ...(args.opcodeTable !== undefined ? { opcodeTable: args.opcodeTable } : {}),
      verifyFooter: args.verify,
    });
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            version: module.header.version,
            layoutClass: module.layout.layoutClass,
            opcodeTable: module.layout.opcodeTable ?? null,
            probe: module.layout.probe,
            functionCount: module.functions.length,
            stringCount: module.strings.count,
            sections: module.sections.all,
            diagnostics: module.diagnostics,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(`hbc2js --info ${args.info}\n`);
      process.stdout.write(`  version:       ${module.header.version}\n`);
      process.stdout.write(`  layout class:  ${module.layout.layoutClass}\n`);
      process.stdout.write(`  opcode table:  ${module.layout.opcodeTable ?? "(none generated for this version)"}\n`);
      process.stdout.write(`  probe chosen:  ${module.layout.probe.chosen} (decided by: ${module.layout.probe.decidedBy.join(", ") || "version"})\n`);
      process.stdout.write(`  functions:     ${module.functions.length}\n`);
      process.stdout.write(`  strings:       ${module.strings.count}\n`);
      process.stdout.write(`  sections:\n`);
      for (const s of module.sections.all) {
        process.stdout.write(`    ${s.name.padEnd(20)} offset=0x${s.offset.toString(16)} size=${s.size}\n`);
      }
      if (module.diagnostics.length > 0) {
        process.stdout.write(`  diagnostics:\n`);
        for (const d of module.diagnostics) process.stdout.write(`    [${d.severity}] ${d.code}: ${d.message}\n`);
      }
    }
    process.exit(0);
  } catch (e) {
    if (e instanceof Hbc2jsError) {
      fail(e.code, e.message, exitCodeFor(e.code), args.json);
    }
    fail(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e), 1, args.json);
  }
}

main();
