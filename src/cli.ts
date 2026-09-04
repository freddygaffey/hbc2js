#!/usr/bin/env node
// docs/specs/00-project-skeleton.md §6.3 — the only place in the codebase allowed to
// touch stdout/stderr or call process.exit.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import v8 from "node:v8";
import { ErrorCode, Hbc2jsError } from "./errors.ts";
import { parseHbc } from "./parse/module.ts";
import type { LayoutClass, OpcodeTableId } from "./parse/types.ts";
import { printModule } from "./disasm/print.ts";
import type { DisasmMode } from "./disasm/print.ts";
import { VERSION } from "./version.ts";
import { runProgram } from "./harness/runner.ts";
import type { RunOptions } from "./harness/runner.ts";
import { compareTraces, TRACE_VERDICT } from "./harness/compare.ts";
import { hbcVersion, findHermesVm, runHermes, findAllHermesVms } from "./harness/hermes-vm.ts";
import { normaliseModule, diffNormalised } from "./harness/roundtrip.ts";
import { runTier, hbc2jsDecompiler } from "./harness/tiers.ts";
import type { Tier } from "./harness/tiers.ts";
import { VERDICT } from "./harness/ladder.ts";
import type { OracleName } from "./harness/ladder.ts";
import { decompile, decompileAst, decompileTree, nodeCheck, parseForDecompile } from "./decompile.ts";
import { analyseModule } from "./cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "./name-overlay/index.ts";
import type { Confidence, NameRecord, Source } from "./name-overlay/index.ts";
import { describePasses } from "./passes/index.ts";
import { runDeps } from "./deps/index.ts";
import { formatReportText, packageJsonDependencies } from "./deps/report.ts";
import { splitProject } from "./split/index.ts";
import { writeSplitResult } from "./split/write.ts";
import { writeArtifact } from "./artifact/write.ts";
import { buildIndexRows } from "./artifact/index-rows.ts";
import { openProjectDb } from "./projdb/db.ts";
import { initProjectDb } from "./projdb/ix-write.ts";
import { exportProject } from "./projdb/export.ts";
import { rebuildProject } from "./projdb/rebuild.ts";
import { verifyProject } from "./projdb/verify.ts";
import { adoptShard, allShardPaths, classifyThreeWay, diffShard, restoreShard } from "./projdb/threeway.ts";
import { installPreCommitHook } from "./projdb/hooks.ts";
import { ArtifactService } from "./artifact/service.ts";
import { listNameable, contextSites } from "./artifact/frame-queries.ts";
import { rawFrameBodies } from "./name-overlay/frames.ts";
import { readSplitDir, segregateSplitTree, writeSegregateResult } from "./split/segregate.ts";
import type { DepsReport } from "./deps/report.ts";
import { ProjectService } from "./project/service.ts";
import type { AnnotationRow } from "./project/service.ts";
import type { EvidenceRef, FindingStatus, Provenance, Severity, Tag } from "./project/schema.ts";
import type { ResolvedFinding } from "./project/findings.ts";
import { SecretsService } from "./secrets/service.ts";
import { startUiServer } from "./ui-server/server.ts";
import type { Tier as SecretTier } from "./secrets/patterns.ts";

const USAGE = `hbc2js ${VERSION} — Hermes bytecode (HBC) -> JavaScript decompiler

Usage:
  hbc2js <input.hbc> [out.js]      decompile to JavaScript (specs 03-05)
  hbc2js --info <input.hbc>        print header/layout/section info and exit
  hbc2js disasm <input.hbc> [options]   disassemble to text (spec 02)
  hbc2js equiv <a.js> <b.js>       execution-trace equivalence (spec 06)
  hbc2js equiv --hbc <a.hbc> <b.js>     bytecode (Hermes VM) vs decompiled JS
  hbc2js equiv normalise <a.hbc> <b.hbc>  normalised-disassembly diff (D3)
  hbc2js gate [options]            run the gate tier (spec 06 §7)
  hbc2js sweep [options]           run the sweep tier (spec 06 §7)
  hbc2js deps <bundle.hbc|.apk>    identify npm dependencies (D17/D17a/D17b)
  hbc2js name <set|get|revert|search|list|context> …   Design-D naming overlay (rename-tool-DESIGN-D-overlay.md)
  hbc2js render --hbc <in.hbc>     render source with the naming overlay applied
  hbc2js segregate <split-dir>     segregate a flat split tree into src/node_modules form (spec 08)
  hbc2js query <verb> --artifact <dir> …   query the P2.1 decompile artifact (docs/specs/10-artifact-format.md §3)
  hbc2js project <verb> --artifact <dir> …   the P2.2 project store: tags/comments/bookmarks/findings (docs/specs/11-project-store.md §3)
  hbc2js secrets <verb> --artifact <dir> …   the P2.3 string-secrets indexer: scan/report/list/show/hosts/paths (docs/specs/12-string-secrets.md §5)
  hbc2js init <bundle.hbc> [--out <dir>]     create a project.hbcproj (docs/specs/16-project-db.md §4.1): split
                                              render + ix_* index rows in one SQLite file; refuses if it exists
  hbc2js hbcproj export <project.hbcproj>    materialise analysis/ + log/ shards from the DB
  hbc2js hbcproj rebuild <project.hbcproj>   regenerate a FRESH DB's annotation state from analysis/ + log/ (recovery)
  hbc2js hbcproj verify <project.hbcproj> [--full]   check shard hashes + the log/ chain; --full re-runs round-trip validators
  hbc2js hbcproj status <project.hbcproj>    classify every analysis/ shard clean/lag/hand-edit/conflict against the db
  hbc2js hbcproj diff <project.hbcproj> [shard...]   show the content difference for changed shards
  hbc2js hbcproj adopt <project.hbcproj> (<shard>|--all) [--force]   fold a hand-edited shard into the db, re-locked
  hbc2js hbcproj restore <project.hbcproj> (<shard>|--all)   discard a hand edit / catch up a lagging shard from the db
  hbc2js hbcproj install-hooks <project.hbcproj> [--force]   (re)install the git pre-commit hook (§11); \`init\` does this best-effort already
                                              (docs/specs/18-project-storage-integrity.md §9 step 0)
  hbc2js ui-server <projectDir> [--port N] [--hbc <bundle.hbc>] [--workers off] [--no-prewarm]   serve the Stage-3 UI's JSON API (+ static ui/dist/,
                                              docs/specs/22-ui-mvp.md §1/§3) over that project directory, localhost only
                                              (--no-prewarm skips the post-listen whole-bundle frame warm, docs/UI.md "Cold start")
  hbc2js --help                    print this message
  hbc2js --version                 print the version

Options (decompile):
  --function=N              restrict --emit-tree to function index N
  --no-verify               skip the structurer's round-trip isomorphism check
  --emit-tree               print the structurer's tree IR instead of JavaScript
  --emit-ast                print the stage-B JS AST per function instead of JavaScript
  --no-pass <name>          disable one readability pass (repeatable; spec 07)
  --passes=none             run no passes: the M4 baseline output
  --list-passes             list the registered passes and exit
  --no-node-check           skip the built-in 'node --check' of the output
  --jsx                     opt-in jsx-recover rung (D20): React element calls
                            print as JSX; output is not runnable JS, so the
                            node --check is skipped. With --split, runs the
                            full pass pipeline on every module too.
  --split <outdir>          split into a per-module project tree instead of one
                            file (D17i stage 1 — isolate; docs/DECISIONS.md);
                            also writes a P2.1 artifact (manifest.json +
                            index/*, docs/specs/10-artifact-format.md) into
                            <outdir>
  --overwrite               with --split: allow overwriting an existing
                            artifact directory (default: refuse, §1.3 E4)
  --opcode-table=<id>       force an opcode table instead of probing
  --force-v98-table         resolve E_LAYOUT_AMBIGUOUS by forcing hbc98-late
  --lenient-env             don't refuse the module when an environment access
                            cannot be resolved statically; emit a loud
                            __hbc_unresolved_env(...) marker per site instead
  --stats                   print structurer statistics to stderr
  -o <file>                 write to a file instead of stdout

Memory: decompiling needs roughly 300x the input size in heap (a 10 MB bundle
  ~3 GB, a 50 MB bundle ~15 GB). Node's default old-space is well under that for
  anything past ~15 MB, so large bundles need
    node --max-old-space-size=<MB> $(command -v hbc2js) <in.hbc>
  hbc2js prints the exact figure before it starts rather than dying in the
  collector with no explanation.

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
  --identity                score the identity decompiler (harness self-test)
                            instead of the real one
  --oracles <list>          comma-separated oracle set (default: syntax,trace —
                            or all four with --identity)
  exit 0 all PASS  1 any DIVERGENT/ERROR  2 any INCONCLUSIVE only

Options (deps):
  --out <dir>               decompile-project output dir (project-local DB lives at <dir>/.hbc2js/sigdb)
  --confirm                 run the npm confirm stage (network; never executes package code)
  --offline                 skip npm registry search + the confirm stage entirely
  --sigdb <dir>             override the project-local signature-DB directory
  --no-shared-db            don't consult tools/pkgsig/db (this repo's starter set)
  --min-instr <n>           minimum-instruction floor before a hash is trusted (default 8)
  --json                    machine-readable DepsReport on stdout
  --exhaustive              score every signature file in every DB layer (pre-QUEUE-22a behaviour);
                             default is evidence-directed: only packages the bundle's own strings
                             give a reason to check (docs/DEPS.md, "evidence-directed matching")

hbc2js segregate <split-dir> [outDir]   (docs/specs/08-segregation.md, milestones 1-3)
  Places a --split tree's modules into node_modules/<pkg>/ (library,
  classify.ts verdict) vs src/ (custom, or named from call/config shape —
  see below) vs _unclassified/ (no verdict, no name signal either).
  src/ modules are named from entry/app-registration/displayName/default-
  export/createSlice/navigator/screen-route signals. Navigator (§3.1) and
  screen (§3.2) detection fire on the create<X>Navigator(...) call shape and
  route-config string literals ALONE — a --deps-report is a CONFIRMING
  signal (raises confidence) but is not required, so screens/navigators are
  still recovered when deps is slow or hasn't been run. outDir defaults to
  "<split-dir>-segregated".
  --deps-report <file>      a 'hbc2js deps --json' report (classification +
                            moduleOwnership); omit to rely on call/config
                            shape alone (lower confidence, no library/src
                            guess for modules with no name signal — those
                            still land in _unclassified/)
  --json                    machine-readable summary on stdout
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
  /** `--identity`: score the harness's identity stand-in, not the decompiler. */
  readonly identity: boolean;
  readonly oracles: OracleName[] | undefined;
}

function parseTierArgs(argv: readonly string[]): TierArgs {
  let json = false;
  let only: string[] | undefined;
  let versions: number[] | undefined;
  let identity = false;
  let oracles: OracleName[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--identity") identity = true;
    else if (a === "--oracles") oracles = String(argv[++i]).split(",").filter((s) => s.length > 0) as OracleName[];
    else if (a === "--only") only = String(argv[++i]).split(",").filter((s) => s.length > 0);
    else if (a === "--versions") versions = String(argv[++i])
        .split(",")
        .filter((s) => s.length > 0)
        .map(Number);
  }
  return { json, only, versions, identity, oracles };
}

async function runTierCmd(tier: Tier, argv: readonly string[]): Promise<number> {
  const o = parseTierArgs(argv);
  // review M4-H1: the gate scored the *identity* decompiler by default, so the
  // command the docs point at contained no execution-equivalence check of the
  // decompiler at all. The real one is the default now; `--identity` keeps the
  // harness self-test reachable.
  const report = await runTier({
    tier,
    ...(o.identity ? {} : { decompiler: hbc2jsDecompiler }),
    ...(o.oracles !== undefined ? { oracles: o.oracles } : {}),
    ...(o.only !== undefined ? { only: o.only } : {}),
    ...(o.versions !== undefined ? { versions: o.versions } : {}),
  });
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

interface DecompileArgs {
  readonly help: boolean;
  readonly input: string | undefined;
  readonly outPath: string | undefined;
  readonly functionIndex: number | undefined;
  readonly verify: boolean;
  readonly emitTree: boolean;
  readonly emitAst: boolean;
  readonly nodeCheck: boolean;
  readonly split: string | undefined;
  /** `--overwrite`: allow `--split` to write a manifest.json artifact
   *  (docs/specs/10-artifact-format.md §1.3/§10 E4) into a directory that
   *  already holds one. Default: refuse. */
  readonly overwrite: boolean;
  readonly opcodeTable: OpcodeTableId | undefined;
  readonly forceV98: boolean;
  readonly stats: boolean;
  /** `--lenient-env`: markers instead of `E_ENV_UNRESOLVED` (review M4-H2). */
  readonly lenientEnv: boolean;
  /** `--jsx` (D20): opt the `jsx-recover` rung in and print JSX. */
  readonly jsx: boolean;
  readonly passes: { readonly none: boolean; readonly skip: readonly string[]; readonly optIn: readonly string[] };
}

function parseDecompileArgs(argv: readonly string[]): DecompileArgs {
  let help = false;
  let input: string | undefined;
  let outPath: string | undefined;
  let functionIndex: number | undefined;
  let verify = true;
  let emitTree = false;
  let emitAst = false;
  let check = true;
  let split: string | undefined;
  let overwrite = false;
  let opcodeTable: OpcodeTableId | undefined;
  let forceV98 = false;
  let stats = false;
  let lenientEnv = false;
  let jsx = false;
  let passesNone = false;
  const skipPasses: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "-o") outPath = argv[++i];
    else if (a === "--passes=none") passesNone = true;
    else if (a === "--no-pass") skipPasses.push(String(argv[++i]));
    else if (a.startsWith("--no-pass=")) skipPasses.push(a.slice("--no-pass=".length));
    else if (a.startsWith("--function=")) functionIndex = Number(a.slice("--function=".length));
    else if (a === "--no-verify") verify = false;
    else if (a === "--emit-tree") emitTree = true;
    else if (a === "--emit-ast") emitAst = true;
    else if (a === "--no-node-check") check = false;
    else if (a === "--split") split = argv[++i];
    else if (a === "--overwrite") overwrite = true;
    else if (a === "--force-v98-table") forceV98 = true;
    else if (a === "--stats") stats = true;
    else if (a === "--lenient-env") lenientEnv = true;
    else if (a === "--jsx") jsx = true;
    else if (a.startsWith("--opcode-table=")) opcodeTable = a.slice("--opcode-table=".length) as OpcodeTableId;
    else if (!a.startsWith("-")) positional.push(a);
  }
  input = positional[0];
  if (outPath === undefined) outPath = positional[1];
  return { help, input, outPath, functionIndex, verify, emitTree, emitAst, nodeCheck: check, split, overwrite, opcodeTable, forceV98, stats, lenientEnv, jsx, passes: { none: passesNone, skip: skipPasses, optIn: jsx ? ["jsx-recover"] : [] } };
}

/**
 * Review M4-H2: a 50 MB bundle died with `FATAL ERROR: … JavaScript heap out of
 * memory` half an hour into a run, which tells the caller nothing actionable.
 * Peak heap is close to linear in the input (measured: Bloomberg 10.5 MB ->
 * 3.4 GB, Discord 51 MB -> ~4.9 GB before it refused, both well past Node's
 * default old-space), so say the number and the exact flag up front.
 */
function warnIfHeapTooSmall(inputBytes: number, name: string): void {
  const HEAP_PER_INPUT_BYTE = 300;
  const needBytes = inputBytes * HEAP_PER_INPUT_BYTE;
  const limitBytes = v8.getHeapStatistics().heap_size_limit;
  if (needBytes <= limitBytes) return;
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
  process.stderr.write(
    `hbc2js: ${name} is ${(inputBytes / 1024 ** 2).toFixed(1)} MB; decompiling it needs roughly ${gb(needBytes)} GB of heap ` +
      `and this Node's limit is ${gb(limitBytes)} GB.\n` +
      `        Re-run as: node --max-old-space-size=${Math.ceil(needBytes / 1024 ** 2)} $(command -v hbc2js) ${name} ...\n`,
  );
}

/** `hbc2js <input.hbc> [out.js]` — docs/specs/05-emitter.md §1. */
function runDecompile(argv: readonly string[]): void {
  const args = parseDecompileArgs(argv);
  if (args.help || args.input === undefined) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(args.input);
  } catch (e) {
    fail(ErrorCode.E_IO, `cannot read ${args.input}: ${e instanceof Error ? e.message : String(e)}`, 2, false);
  }
  try {
    const opts = {
      moduleName: basename(args.input),
      verify: args.verify,
      resolveV98Ambiguity: args.forceV98,
      strictEnv: !args.lenientEnv,
      passes: args.passes,
      ...(args.jsx ? { emit: { jsx: true } } : {}),
      ...(args.opcodeTable !== undefined ? { opcodeTable: args.opcodeTable } : {}),
      ...(args.functionIndex !== undefined ? { functionIndex: args.functionIndex } : {}),
    };
    warnIfHeapTooSmall(bytes.length, basename(args.input));
    if (args.split !== undefined) {
      const result = splitProject(bytes, { moduleName: basename(args.input), ...(args.jsx ? { passes: args.passes, jsx: true } : {}) });
      writeSplitResult(result, args.split);
      for (const d of result.diagnostics) process.stderr.write(`hbc2js --split: ${d}\n`);
      const artifact = writeArtifact({
        bytes,
        splitResult: result,
        outDir: args.split,
        passes: args.passes,
        strictEnv: false,
        form: "flat",
        overwrite: args.overwrite,
      });
      process.stdout.write(
        `hbc2js: wrote ${result.modules.length} module file(s) + index.js + MODULES.json to ${args.split}\n` +
          `hbc2js: wrote artifact manifest.json + index/{functions.jsonl,modules.json,ranges.jsonl} ` +
          `(${artifact.functionCount} functions, ${artifact.moduleCount} modules, ${artifact.rangeCount} ranges) to ${args.split}\n`,
      );
      process.exit(0);
    }
    let text: string;
    if (args.emitTree) {
      text = decompileTree(bytes, opts);
    } else if (args.emitAst) {
      text = decompileAst(bytes, opts);
    } else {
      const result = decompile(bytes, opts);
      text = result.code;
      const unresolved = result.diagnostics.filter((d) => d.code === "W_ENV_UNRESOLVED").length;
      if (unresolved > 0) {
        process.stderr.write(`hbc2js: --lenient-env: ${unresolved} environment access(es) could not be resolved statically and were emitted as __hbc_unresolved_env(...) markers, which THROW when reached. The output is not faithful at those sites.\n`);
      }
      if (result.decompileDiagnostics > 0) {
        process.stderr.write(`hbc2js: ${result.decompileDiagnostics} of ${result.module.functions.length} functions could not be decompiled (stubbed) — each throws a descriptive Error if reached; see the W_FUNCTION_STUBBED diagnostics.\n`);
      }
    }
    // D20: `--jsx` output is JSX, not runnable JS — the faithfulness guard is
    // jsx-recover's offline inverse check (spec 08 §6), not `node --check`.
    if (!args.emitTree && !args.emitAst && args.nodeCheck && !args.jsx) {
      const check = nodeCheck(text);
      if (!check.ok) {
        process.stderr.write(`hbc2js: emitted JavaScript did not pass 'node --check':\n${check.message}\n`);
        if (args.outPath !== undefined) writeFileSync(args.outPath, text);
        process.exit(5);
      }
    }
    if (args.outPath !== undefined) writeFileSync(args.outPath, text);
    else process.stdout.write(text);
    process.exit(0);
  } catch (e) {
    if (e instanceof Hbc2jsError) fail(e.code, e.message, exitCodeFor(e.code), false);
    fail(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e), 1, false);
  }
}

// ---------------------------------------------------------------------------
// `hbc2js init <bundle.hbc>` — docs/specs/16-project-db.md §4.1 fresh path.
// ---------------------------------------------------------------------------

/** `hbc2js init <bundle.hbc> [--out <dir>]`: splits + renders as `--split`
 *  does (§4.1 step 1), then creates `<outDir>/project.hbcproj` (step 2) and
 *  builds the `ix_*` stratum via the same builders `--split`'s artifact uses
 *  (`buildIndexRows`, step 3, "the extractors are reused verbatim, only the
 *  sink changes"), and writes the `init` + `rebuild-index` (gen 1) `log`
 *  rows (step 4). No `index/*.jsonl` is written for this project — §4.1's
 *  "after init, spec-10/11 JSONL files are no longer written by any command
 *  for this project". Refuses (does not `--force`-overwrite) if
 *  `project.hbcproj` already exists (§4.1 step 2, mirrors spec 10 §1.3 E4). */
/** Writes `<outDir>/.gitignore` (§3: "Git-tracked = `src/`, `analysis/`,
 *  `log/`. Gitignored = `cache.db`, `index/`, `scans/`"). This project
 *  stores its operational DB as `project.hbcproj` rather than a `cache.db`
 *  file (spec 16 §4.1's naming, kept as-is here — see the `init` doc
 *  comment above) so it is listed alongside `index/`/`scans/` instead. Only
 *  writes the file if one doesn't already exist, so a re-run (or a repo
 *  that already has its own `.gitignore` conventions) is never clobbered. */
function writeGitignore(outDir: string): void {
  const path = join(outDir, ".gitignore");
  if (existsSync(path)) return;
  writeFileSync(
    path,
    "# docs/specs/18-project-storage-integrity.md §3 — derived/rebuildable state only.\n" +
      "project.hbcproj\n" +
      "index/\n" +
      "scans/\n",
    "utf8",
  );
}

/** `hbc2js ui-server <projectDir> [--port N] [--hbc <bundle.hbc>]` — spec
 *  22 §1/§3: starts the localhost-only JSON server over `src/ui-server/`
 *  and blocks forever (Ctrl-C / SIGTERM to stop), same shape `gate`/`sweep`
 *  give an async subcommand its own exit-code promise. */
async function runUiServer(argv: readonly string[]): Promise<number> {
  const projectDir = argv.find((a) => !a.startsWith("-"));
  if (argv.includes("--help") || projectDir === undefined) {
    process.stdout.write(USAGE);
    return argv.includes("--help") ? 0 : 2;
  }
  const portRaw = flagValue(argv, "--port");
  let port: number | undefined;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port)) {
      process.stderr.write(`hbc2js ui-server: --port must be an integer, got ${portRaw}\n`);
      return 2;
    }
  }
  const hbc = flagValue(argv, "--hbc");
  // spec 23 §2: the server-owned worker pool is ON by default (the shipped
  // backend is offline and deterministic); `--workers off` runs the plain
  // spec-22 server, and the /api/jobs family then answers 503.
  const workersRaw = flagValue(argv, "--workers");
  if (workersRaw !== undefined && workersRaw !== "on" && workersRaw !== "off") {
    process.stderr.write(`hbc2js ui-server: --workers takes on|off, got ${workersRaw}\n`);
    return 2;
  }
  const workers = workersRaw !== "off";
  // docs/UI.md "Cold start": the whole-bundle live-frame analysis is
  // prewarmed right after `listen` by default; `--no-prewarm` skips it
  // (tests use this so a fixture's tiny bundle never warms unasked-for work).
  const prewarm = !argv.includes("--no-prewarm");
  try {
    const handle = await startUiServer({
      projectDir,
      workers,
      ...(hbc !== undefined ? { hbc } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(prewarm ? {} : { prewarm: false }),
    });
    process.stdout.write(`hbc2js ui-server: listening on http://${handle.host}:${handle.port} (project ${projectDir}, workers ${workers ? "on" : "off"})\n`);
    await new Promise<void>(() => {}); // serve forever; Ctrl-C/SIGTERM stops it (no --detach in this MVP, spec 22 §1)
    return 0;
  } catch (e) {
    process.stderr.write(`hbc2js ui-server: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function runInit(argv: readonly string[]): number {
  const input = argv.find((a) => !a.startsWith("-"));
  if (argv.includes("--help") || input === undefined) {
    process.stdout.write(USAGE);
    return argv.includes("--help") ? 0 : 2;
  }
  const outDir = flagValue(argv, "--out") ?? `${input.replace(/\.hbc$/, "")}-project`;
  const dbPath = join(outDir, "project.hbcproj");
  if (existsSync(dbPath)) {
    process.stderr.write(`hbc2js init: ${dbPath} already exists — init refuses to overwrite an existing project.hbcproj (docs/specs/16-project-db.md §4.1); archive or remove it first\n`);
    return 3;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(input);
  } catch (e) {
    process.stderr.write(`hbc2js init: cannot read ${input}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    const splitResult = splitProject(bytes, { moduleName: basename(input) });
    // §3's layout puts decompiled source under `src/`, not the project root
    // (the root also holds `analysis/`, `log/`, `project.hbcproj` — mixing
    // split output in with those would make the pre-commit hook's staged-
    // path filter below ambiguous between "source changed" and "state
    // changed").
    writeSplitResult(splitResult, join(outDir, "src"));
    writeGitignore(outDir);
    const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
    const db = openProjectDb(dbPath);
    try {
      initProjectDb(db, rows, { actorWho: "hbc2js-cli" });
    } finally {
      db.close();
    }
    // Best-effort (§9's `init` row: "scaffold the project; install the git
    // pre-commit hook" — a bundle-only run outside any git working tree
    // must not fail just because there is nowhere to put a hook; §11's
    // enforcement only matters once the project is actually committed to).
    const hookResult = installPreCommitHook(outDir, resolve(process.argv[1] ?? "hbc2js"));
    process.stdout.write(
      `hbc2js init: wrote ${splitResult.modules.length} module file(s) to ${join(outDir, "src")} and ${dbPath} ` +
        `(${rows.functionRows.length} functions, ${rows.modulesIndex.modules.length} modules, ${rows.callRows.length} calls)\n` +
        (hookResult.installed
          ? `hbc2js init: installed pre-commit hook at ${hookResult.hookPath} (docs/specs/18-project-storage-integrity.md §11)\n`
          : `hbc2js init: pre-commit hook not installed (${hookResult.reason}) — run \`hbc2js hbcproj install-hooks ${dbPath}\` once this is a git repo\n`),
    );
    return 0;
  } catch (e) {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        /* best-effort cleanup of a partial project.hbcproj */
      }
    }
    if (e instanceof Hbc2jsError) {
      process.stderr.write(`hbc2js init: ${e.message}\n`);
      return exitCodeFor(e.code);
    }
    process.stderr.write(`hbc2js init: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// `hbc2js hbcproj export <project.hbcproj>` — docs/specs/18-project-storage-
// integrity.md §9 `export` verb, §R4 implementation-plan step 0.
// ---------------------------------------------------------------------------

/** `hbc2js hbcproj export <project.hbcproj>`: materialises `analysis/` +
 *  `log/` alongside the given `.hbcproj` DB file (§6 step 3, `src/projdb/
 *  export.ts`). `export`/`rebuild`/`verify`/`status`/`diff`/`adopt`/
 *  `restore` are implemented (§R4 steps 0-3, `src/projdb/threeway.ts` for
 *  the last four); `init` (a separate command, `runInit` above) already
 *  covers §9's project-creation verb. */
function runHbcproj(argv: readonly string[]): number {
  const verb = argv[0];
  if (verb === "install-hooks") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write(
        "hbc2js hbcproj install-hooks <project.hbcproj> [--force]   (re)install the pre-commit hook that blocks committing un-adopted state (docs/specs/18-project-storage-integrity.md §11); " +
          "`init` already does this best-effort — use this to retry once the project is inside a git working tree, or after a hook shape upgrade\n",
      );
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj install-hooks: ${dbFile} does not exist\n`);
      return 2;
    }
    const result = installPreCommitHook(dirname(dbFile), resolve(process.argv[1] ?? "hbc2js"), { force: argv.includes("--force") });
    if (!result.installed) {
      process.stderr.write(`hbc2js hbcproj install-hooks: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`hbc2js hbcproj install-hooks: installed ${result.hookPath}\n`);
    return 0;
  }
  if (verb === "export") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write("hbc2js hbcproj export <project.hbcproj>   materialise analysis/ + log/ shards from the DB (docs/specs/18-project-storage-integrity.md §6 step 0)\n");
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj export: ${dbFile} does not exist\n`);
      return 2;
    }
    const db = openProjectDb(dbFile);
    try {
      const result = exportProject(db, dirname(dbFile));
      process.stdout.write(`hbc2js hbcproj export: wrote ${result.written.length} shard(s), ${result.unchanged.length} unchanged (no-op)\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj export: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "rebuild") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write(
        "hbc2js hbcproj rebuild <project.hbcproj>   regenerate the DB's annotation state from analysis/ + log/ (docs/specs/18-project-storage-integrity.md §6 step 1); " +
          "the target must be a FRESH db (no prior revisions/log rows — append-only, cannot be wiped in place)\n",
      );
      return argv.includes("--help") ? 0 : 2;
    }
    const projectDir = dirname(dbFile);
    if (!existsSync(projectDir)) {
      process.stderr.write(`hbc2js hbcproj rebuild: ${projectDir} does not exist\n`);
      return 2;
    }
    const db = openProjectDb(dbFile); // creates a fresh schema if dbFile doesn't exist yet (the recovery case, §8)
    try {
      const result = rebuildProject(db, projectDir);
      process.stdout.write(
        `hbc2js hbcproj rebuild: restored ${result.activeWritten} active record(s), ${result.revisionsWritten} revisions row(s), ${result.logEntriesWritten} log row(s)` +
          (result.warnings.length > 0 ? `, ${result.warnings.length} warning(s):\n${result.warnings.map((w) => `  - ${w}`).join("\n")}\n` : "\n"),
      );
      return 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj rebuild: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "verify") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write(
        "hbc2js hbcproj verify <project.hbcproj> [--full]   check shard content-hashes + the log/ hash chain, classifying any divergence as lag or a hand edit (docs/specs/18-project-storage-integrity.md §8/§9); " +
          "--full additionally re-runs the DB<->shards agreement and rebuild round-trip validators (§R3)\n",
      );
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj verify: ${dbFile} does not exist\n`);
      return 2;
    }
    const db = openProjectDb(dbFile);
    try {
      const result = verifyProject(db, dirname(dbFile), { full: argv.includes("--full") });
      for (const s of result.shards) if (s.status !== "ok") process.stdout.write(`${s.status}: ${s.path}${s.detail !== undefined ? ` — ${s.detail}` : ""}\n`);
      for (const c of result.logChain) if (!c.ok) process.stdout.write(`log-chain-broken: ${c.path}${c.detail !== undefined ? ` — ${c.detail}` : ""}\n`);
      if (result.full !== undefined) {
        for (const d of result.full.detail) process.stdout.write(`full: ${d}\n`);
        process.stdout.write(`full: round-trip=${result.full.roundTrip ? "ok" : "FAIL"} db-shards-agree=${result.full.dbShardsAgree ? "ok" : "FAIL"}\n`);
      }
      process.stdout.write(`hbc2js hbcproj verify: ${result.shards.length} shard(s) checked, ${result.logChain.length} log file(s) checked — ${result.ok ? "OK" : "FAILED"}\n`);
      return result.ok ? 0 : 1;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj verify: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "status") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write("hbc2js hbcproj status <project.hbcproj>   classify every analysis/ shard clean/lag/hand-edit/conflict against the db (docs/specs/18-project-storage-integrity.md §10)\n");
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj status: ${dbFile} does not exist\n`);
      return 2;
    }
    const db = openProjectDb(dbFile);
    try {
      const shards = classifyThreeWay(db, dirname(dbFile));
      for (const s of shards) process.stdout.write(`${s.status}: ${s.path}${s.detail !== undefined ? ` — ${s.detail}` : ""}\n`);
      const counts = { clean: 0, lag: 0, "hand-edit": 0, conflict: 0, "corrupt-json": 0 } as Record<string, number>;
      for (const s of shards) counts[s.status] = (counts[s.status] ?? 0) + 1;
      process.stdout.write(`hbc2js hbcproj status: ${shards.length} shard(s) — clean=${counts.clean} lag=${counts.lag} hand-edit=${counts["hand-edit"]} conflict=${counts.conflict} corrupt-json=${counts["corrupt-json"]}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj status: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "diff") {
    const dbFile = argv.slice(1).find((a) => !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write("hbc2js hbcproj diff <project.hbcproj> [shard-path...]   show the content difference between changed shards and what the db would currently produce (docs/specs/18-project-storage-integrity.md §10); defaults to every non-clean shard\n");
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj diff: ${dbFile} does not exist\n`);
      return 2;
    }
    const db = openProjectDb(dbFile);
    try {
      const projectDir = dirname(dbFile);
      const requested = argv.slice(1).filter((a) => !a.startsWith("-") && a !== dbFile);
      const targets = requested.length > 0 ? requested : classifyThreeWay(db, projectDir).filter((s) => s.status !== "clean").map((s) => s.path);
      if (targets.length === 0) {
        process.stdout.write("hbc2js hbcproj diff: every shard is clean — nothing to diff\n");
        return 0;
      }
      for (const path of targets) process.stdout.write(diffShard(db, path));
      return 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj diff: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "adopt") {
    const dbFile = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write(
        "hbc2js hbcproj adopt <project.hbcproj> (<shard-path>|--all) [--force] [--who <name>]   fold a hand-edited shard into the db, exactly like an MCP write, and re-lock it (docs/specs/18-project-storage-integrity.md §10); rejects a shard that fails validation or is a --force-less conflict\n",
      );
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj adopt: ${dbFile} does not exist\n`);
      return 2;
    }
    const rest = argv.slice(1).filter((a) => a !== dbFile);
    const force = rest.includes("--force");
    const whoIdx = rest.indexOf("--who");
    const who = flagValue(rest, "--who") ?? "hbcproj-cli";
    // `whoIdx === -1` (no `--who` given) must not filter out index 0 — the
    // naive `i !== whoIdx + 1` check does exactly that (`-1 + 1 === 0`),
    // silently dropping a lone shard-path argument and turning `hbcproj
    // adopt <db> <shard>` into "no shard given" (found via
    // tests/gate/cli/hbcproj-hooks.test.ts, which — unlike the other adopt
    // tests — calls adopt without `--who`).
    const explicit = rest.filter((a, i) => a !== "--all" && a !== "--force" && (whoIdx === -1 || (i !== whoIdx && i !== whoIdx + 1)));
    const db = openProjectDb(dbFile);
    try {
      const projectDir = dirname(dbFile);
      const targets = rest.includes("--all") ? allShardPaths(projectDir) : explicit;
      if (targets.length === 0) {
        process.stdout.write("hbc2js hbcproj adopt: no shard given — pass a shard path or --all\n");
        return 2;
      }
      let failures = 0;
      for (const path of targets) {
        const result = adoptShard(db, projectDir, path, { source: "human", who }, { force });
        if (result.ok) process.stdout.write(`adopted: ${path} (${result.rids?.length ?? 0} write(s))\n`);
        else {
          failures++;
          process.stdout.write(`rejected: ${path} — ${result.reason}\n`);
        }
      }
      process.stdout.write(`hbc2js hbcproj adopt: ${targets.length - failures}/${targets.length} shard(s) adopted\n`);
      return failures > 0 ? 1 : 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj adopt: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (verb === "restore") {
    const dbFile = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (argv.includes("--help") || dbFile === undefined) {
      process.stdout.write("hbc2js hbcproj restore <project.hbcproj> (<shard-path>|--all)   discard a hand edit / catch up a lagging shard by re-materialising it from the db (docs/specs/18-project-storage-integrity.md §10)\n");
      return argv.includes("--help") ? 0 : 2;
    }
    if (!existsSync(dbFile)) {
      process.stderr.write(`hbc2js hbcproj restore: ${dbFile} does not exist\n`);
      return 2;
    }
    const rest = argv.slice(1).filter((a) => a !== dbFile);
    const explicit = rest.filter((a) => a !== "--all");
    const db = openProjectDb(dbFile);
    try {
      const projectDir = dirname(dbFile);
      const targets = rest.includes("--all") ? allShardPaths(projectDir) : explicit;
      if (targets.length === 0) {
        process.stdout.write("hbc2js hbcproj restore: no shard given — pass a shard path or --all\n");
        return 2;
      }
      for (const path of targets) {
        const result = restoreShard(db, projectDir, path);
        process.stdout.write(`restored: ${path}${result.deleted === true ? " (deleted — no live db content for this shard)" : ""}\n`);
      }
      process.stdout.write(`hbc2js hbcproj restore: ${targets.length} shard(s) restored\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`hbc2js hbcproj restore: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.close();
    }
  }
  process.stderr.write(`hbc2js hbcproj: unknown or unimplemented verb ${verb ?? "(none)"} — only 'export'/'rebuild'/'verify'/'status'/'diff'/'adopt'/'restore'/'install-hooks' are implemented (docs/specs/18-project-storage-integrity.md §R4 steps 0-4)\n`);
  return 2;
}

// ---------------------------------------------------------------------------
// `hbc2js deps` — docs/DECISIONS.md D17/D17a/D17b.
// ---------------------------------------------------------------------------

interface DepsArgs {
  readonly help: boolean;
  readonly input: string | undefined;
  readonly out: string | undefined;
  readonly confirm: boolean;
  readonly offline: boolean;
  readonly sigdb: string | undefined;
  readonly noSharedDb: boolean;
  readonly minInstr: number | undefined;
  readonly json: boolean;
  readonly exhaustive: boolean;
}

function parseDepsArgs(argv: readonly string[]): DepsArgs {
  let help = false;
  let input: string | undefined;
  let out: string | undefined;
  let confirm = false;
  let offline = false;
  let sigdb: string | undefined;
  let noSharedDb = false;
  let minInstr: number | undefined;
  let json = false;
  let exhaustive = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--out") out = argv[++i];
    else if (a === "--confirm") confirm = true;
    else if (a === "--offline") offline = true;
    else if (a === "--sigdb") sigdb = argv[++i];
    else if (a === "--no-shared-db") noSharedDb = true;
    else if (a === "--min-instr") minInstr = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (a === "--exhaustive") exhaustive = true;
    else if (input === undefined && !a.startsWith("-")) input = a;
  }
  return { help, input, out, confirm, offline, sigdb, noSharedDb, minInstr, json, exhaustive };
}

async function runDepsCmd(argv: readonly string[]): Promise<number> {
  const args = parseDepsArgs(argv);
  if (args.help || args.input === undefined) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  try {
    const result = await runDeps(args.input, {
      ...(args.out !== undefined ? { out: args.out } : {}),
      confirm: args.confirm,
      offline: args.offline,
      ...(args.sigdb !== undefined ? { sigdb: args.sigdb } : {}),
      noSharedDb: args.noSharedDb,
      exhaustive: args.exhaustive,
      ...(args.minInstr !== undefined ? { minInstr: args.minInstr } : {}),
      // `--confirm` can take several minutes with no other output (a real
      // scratch `npm install`, then one npm-pack + Metro bundle + hermesc
      // compile per candidate) — always to stderr, so it never mixes into
      // `--json`'s stdout.
      ...(args.confirm ? { onProgress: (message: string) => process.stderr.write(`hbc2js deps --confirm: ${message}\n`) } : {}),
    });
    if (args.out !== undefined) {
      const deps = packageJsonDependencies(result.report);
      if (Object.keys(deps).length > 0) {
        mkdirSync(args.out, { recursive: true });
        const pkgJsonPath = join(args.out, "package.json");
        let existing: Record<string, unknown> = { name: "decompiled-app", version: "0.0.0", private: true };
        try {
          existing = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
        } catch {
          // no existing package.json — write a fresh one.
        }
        writeFileSync(pkgJsonPath, JSON.stringify({ ...existing, dependencies: deps }, null, 2) + "\n");
      }
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
    } else {
      process.stdout.write(formatReportText(result.report) + "\n");
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (args.json) process.stdout.write(JSON.stringify({ error: message }) + "\n");
    else process.stderr.write(`hbc2js deps: ${message}\n`);
    return e instanceof Hbc2jsError ? exitCodeFor(e.code) : 3;
  }
}

// ---------------------------------------------------------------------------
// `hbc2js segregate` — docs/specs/08-segregation.md, milestone 1 (§6). CLI
// shape chosen per that spec's open question 1 (recommendation): a separate
// stage from `--split`/`deps`, so re-running segregation (e.g. after a
// future naming-heuristic milestone) never re-decompiles.
// ---------------------------------------------------------------------------

interface SegregateArgs {
  readonly help: boolean;
  readonly splitDir: string | undefined;
  readonly out: string | undefined;
  readonly depsReport: string | undefined;
  readonly json: boolean;
}

function parseSegregateArgs(argv: readonly string[]): SegregateArgs {
  let help = false;
  let splitDir: string | undefined;
  let out: string | undefined;
  let depsReport: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--deps-report") depsReport = argv[++i];
    else if (a === "--json") json = true;
    else if (!a.startsWith("-") && splitDir === undefined) splitDir = a;
    else if (!a.startsWith("-") && out === undefined) out = a;
  }
  return { help, splitDir, out, depsReport, json };
}

function runSegregateCmd(argv: readonly string[]): number {
  const args = parseSegregateArgs(argv);
  if (args.help || args.splitDir === undefined) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  const outDir = args.out ?? `${args.splitDir.replace(/\/+$/, "")}-segregated`;
  try {
    const splitFiles = readSplitDir(args.splitDir);
    const deps: DepsReport | null = args.depsReport !== undefined ? (JSON.parse(readFileSync(args.depsReport, "utf8")) as DepsReport) : null;
    const result = segregateSplitTree(splitFiles, deps);
    writeSegregateResult(result, outDir);
    const counts = { src: 0, node_modules: 0, unclassified: 0 };
    for (const m of result.modules) counts[m.bucket]++;
    if (args.json) {
      process.stdout.write(JSON.stringify({ outDir, moduleCount: result.modules.length, counts }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `hbc2js segregate: ${result.modules.length} module(s) -> ${outDir} (src=${counts.src}, node_modules=${counts.node_modules}, unclassified=${counts.unclassified})\n`,
      );
      if (args.depsReport === undefined) {
        process.stderr.write(
          `hbc2js segregate: no --deps-report given; navigator/screen names came from call/config shape alone (lower confidence); modules with no name signal landed in _unclassified/ (no library/src guess without classify.ts's verdict)\n`,
        );
      }
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (args.json) process.stdout.write(JSON.stringify({ error: message }) + "\n");
    else process.stderr.write(`hbc2js segregate: ${message}\n`);
    return 3;
  }
}

// ---------------------------------------------------------------------------
// Naming overlay (Design D) — `hbc2js name …` and `hbc2js render`.
// docs/specs/rename-tool-DESIGN-D-overlay.md §5, §10; docs/RENAME.md.
// ---------------------------------------------------------------------------

/** Grab `--flag value`; returns undefined when absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function defaultStorePath(hbc: string | undefined, store: string | undefined): string {
  if (store !== undefined) return store;
  if (hbc !== undefined) return `${hbc}.names.json`;
  fail(ErrorCode.E_USAGE, "name/render: give --store <path> or --hbc <input.hbc>", 2, false);
}

function buildAnalysis(hbc: string): ReturnType<typeof analyseModule> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(hbc);
  } catch (e) {
    fail(ErrorCode.E_IO, `cannot read ${hbc}: ${e instanceof Error ? e.message : String(e)}`, 2, false);
  }
  const { module } = parseForDecompile(bytes, {});
  return analyseModule(module, { strictEnv: true });
}

/** The token-minimal record line (spec §10): `{42,7} userInput [med llm gate:passed]`. */
function recordLine(r: NameRecord): string {
  const id = r.id.kind === "reg" ? shortForm(r.id) : `{fn:${r.id.fn}}`;
  return `${id} ${r.name} [${r.confidence} ${r.source} gate:${r.gate}]`;
}

function runNameOverlay(argv: readonly string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  const hbc = flagValue(rest, "--hbc");
  const storePath = defaultStorePath(hbc, flagValue(rest, "--store"));

  if (sub === "set") {
    const fn = Number(rest[0]);
    const reg = Number(rest[1]);
    const name = rest[2];
    if (!Number.isInteger(fn) || !Number.isInteger(reg) || name === undefined || name.startsWith("-")) {
      fail(ErrorCode.E_USAGE, "name set <fn> <reg> <newName> [--conf ...] [--evidence <s>] [--override] [--hbc <in.hbc>]", 2, json);
    }
    if (hbc === undefined) fail(ErrorCode.E_USAGE, "name set requires --hbc <input.hbc> to run the reuse gate", 2, json);
    const confidence = (flagValue(rest, "--conf") ?? "med") as Confidence;
    const evidence = flagValue(rest, "--evidence") ?? "";
    const source = (flagValue(rest, "--source") ?? "human") as Source;
    const override = rest.includes("--override");
    const store = OverlayStore.load(storePath, hbc);
    const svc = new NameService(buildAnalysis(hbc), store);
    const outcome = svc.setName(regId(fn, reg), name, { confidence, evidence, source, override });
    if (!outcome.ok) {
      const hint = outcome.overridable ? " (use --override to force)" : "";
      if (json) process.stdout.write(JSON.stringify({ ok: false, id: { fn, reg }, name, reason: outcome.reason, overridable: outcome.overridable }) + "\n");
      else process.stderr.write(`refused ${shortForm(regId(fn, reg))} ${name} [${outcome.reason}]${hint}\n`);
      process.exit(3);
    }
    store.save(storePath);
    const r = outcome.result.record;
    if (json) process.stdout.write(JSON.stringify(r) + "\n");
    else process.stdout.write(`named ${shortForm(regId(fn, reg))} → ${r.name} [${r.confidence}, gate:${r.gate}]\n`);
    process.exit(0);
  }

  if (sub === "get") {
    const fn = Number(rest[0]);
    const reg = Number(rest[1]);
    if (!Number.isInteger(fn) || !Number.isInteger(reg)) fail(ErrorCode.E_USAGE, "name get <fn> <reg>", 2, json);
    const store = OverlayStore.load(storePath, hbc);
    const r = store.getName(regId(fn, reg));
    if (r === null) {
      if (json) process.stdout.write("null\n");
      else process.stdout.write(`${shortForm(regId(fn, reg))} unnamed (r${reg})\n`);
      process.exit(0);
    }
    if (json) process.stdout.write(JSON.stringify(r) + "\n");
    else process.stdout.write(`${recordLine(r)}\n`);
    process.exit(0);
  }

  if (sub === "revert") {
    const fn = Number(rest[0]);
    const reg = Number(rest[1]);
    if (!Number.isInteger(fn) || !Number.isInteger(reg)) fail(ErrorCode.E_USAGE, "name revert <fn> <reg> [--to <ts>]", 2, json);
    const store = OverlayStore.load(storePath, hbc);
    const to = flagValue(rest, "--to");
    const now = store.revert(regId(fn, reg), to);
    store.save(storePath);
    const target = now === null ? `r${reg}` : now.name;
    if (json) process.stdout.write(JSON.stringify({ id: { fn, reg }, name: now?.name ?? null }) + "\n");
    else process.stdout.write(`reverted ${shortForm(regId(fn, reg))} → ${target}\n`);
    process.exit(0);
  }

  if (sub === "search") {
    const store = OverlayStore.load(storePath, hbc);
    const fnFilter = flagValue(rest, "--fn");
    const results = store.search({
      ...(flagValue(rest, "--conf") !== undefined ? { confidence: flagValue(rest, "--conf") as Confidence } : {}),
      ...(flagValue(rest, "--source") !== undefined ? { source: flagValue(rest, "--source") as Source } : {}),
      ...(flagValue(rest, "--gate") !== undefined ? { gate: flagValue(rest, "--gate") as "passed" | "overridden" } : {}),
      ...(fnFilter !== undefined ? { fn: Number(fnFilter) } : {}),
      ...(flagValue(rest, "--text") !== undefined ? { text: flagValue(rest, "--text")! } : {}),
    });
    if (json) process.stdout.write(JSON.stringify(results) + "\n");
    else for (const r of results) process.stdout.write(`${recordLine(r)}\n`);
    process.exit(0);
  }

  // `name list <fn>` / `name context <fn> <reg>` — P2.1a(b), docs/specs/
  // 10-artifact-format.md §3.1. Live verbs: served from the warm gate/frame
  // computation over the bundle itself, not from the index files (§3.3).
  if (sub === "list") {
    const fn = Number(rest[0]);
    if (!Number.isInteger(fn) || hbc === undefined) fail(ErrorCode.E_USAGE, "name list <fn> --hbc <input.hbc> [--store <path>]", 2, json);
    const frames = rawFrameBodies(buildAnalysis(hbc));
    const overlayStore = existsSync(storePath) ? OverlayStore.load(storePath, hbc) : undefined;
    const rows = listNameable(frames, fn, overlayStore);
    if (json) process.stdout.write(JSON.stringify(rows) + "\n");
    else for (const r of rows) process.stdout.write(`r${r.reg} uses:${r.uses} role:${r.role} named:${r.named ?? "-"}\n`);
    process.exit(0);
  }
  if (sub === "context") {
    const fn = Number(rest[0]);
    const reg = Number(rest[1]);
    if (!Number.isInteger(fn) || !Number.isInteger(reg) || hbc === undefined) fail(ErrorCode.E_USAGE, "name context <fn> <reg> --hbc <input.hbc> [--store <path>]", 2, json);
    const frames = rawFrameBodies(buildAnalysis(hbc));
    const CONTEXT_CAP = 40;
    const rows = contextSites(frames, fn, reg);
    const shown = rows.slice(0, CONTEXT_CAP);
    if (json) process.stdout.write(JSON.stringify({ rows: shown, total: rows.length }) + "\n");
    else {
      for (const r of shown) process.stdout.write(`${r}\n`);
      if (rows.length > shown.length) process.stdout.write(`… ${rows.length - shown.length} more; use --all\n`);
    }
    process.exit(0);
  }

  fail(ErrorCode.E_USAGE, "name <set|get|revert|search|list|context> …", 2, json);
}

// ---------------------------------------------------------------------------
// `hbc2js query <verb> …` — docs/specs/10-artifact-format.md §3. A thin
// formatting wrapper over `ArtifactService`; the caps + truncation markers
// here are the CLI's own presentation of §3.1's bounds, never a second
// source of truth for them (the service already slices to the cap).
// ---------------------------------------------------------------------------
function edgeLine(e: { readonly fn: number | string; readonly file: string | null; readonly line: number | null; readonly kind: string; readonly why?: string }): string {
  const loc = e.file !== null && e.line !== null ? `${e.file}:${e.line}` : "";
  const target = typeof e.fn === "number" ? `fn:${e.fn}` : e.fn;
  const why = e.why !== undefined ? ` why:${e.why}` : "";
  return [target, loc, e.kind + why].filter((s) => s.length > 0).join(" ");
}

/** `query object-tables` text output shows at most this many members per
 *  table before `… (+n more)` — the inventory is a map of the bundle, not a
 *  dump (spec 10 §3.1). */
const MEMBER_LINES = 20;

function truncationLine(total: number, shown: number, hint: string): string | null {
  if (shown >= total) return null;
  return `… ${total - shown} more; use ${hint}`;
}

function runQuery(argv: readonly string[]): void {
  const verb = argv[0];
  const rest = argv.slice(1).filter((a) => a !== "--all" && a !== "--json");
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const artifactDir = flagValue(argv, "--artifact");
  const hbc = flagValue(argv, "--hbc");
  if (artifactDir === undefined) fail(ErrorCode.E_USAGE, "query <verb> --artifact <dir> …", 2, json);

  let svc: ArtifactService;
  try {
    svc = new ArtifactService(artifactDir, hbc !== undefined ? { hbc } : {});
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }

  const positional = rest.filter((a) => !a.startsWith("--"));

  try {
    if (verb === "fn") {
      const summary = svc.fn(Number(positional[0]));
      if (json) {
        process.stdout.write(JSON.stringify(summary) + "\n");
      } else {
        process.stdout.write(
          [
            `fn:${summary.fn} name:${summary.name ?? "-"} overlayName:${summary.overlayName ?? "-"}`,
            `module:${summary.module ?? "-"} file:${summary.file ?? "-"}${summary.lines !== null ? `:${summary.lines[0]}-${summary.lines[1]}` : ""}`,
            `params:${summary.params} kind:${summary.kind}`,
            `edges in:${summary.edgesIn} out:${summary.edgesOut} native:${summary.nativeSurfaceCount}`,
            ...(summary.degraded !== null ? [`! degraded: ${summary.degraded}`] : []),
          ].join("\n") + "\n",
        );
      }
    } else if (verb === "who-calls" || verb === "calls-from") {
      const fn = Number(positional[0]);
      const result = verb === "who-calls" ? svc.whoCalls(fn, { all }) : { ...svc.callsFrom(fn, { all }), unknownInScope: undefined };
      if (json) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        for (const e of result.rows) process.stdout.write(`${edgeLine(e)}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
        if ("unknownInScope" in result && result.unknownInScope !== undefined) process.stdout.write(`unknown-callee edges in scope: ${result.unknownInScope}\n`);
      }
    } else if (verb === "who-calls-by-name") {
      // `who-calls-by-name <fn:N>` or `who-calls-by-name --name X` (§14).
      const nameArg = flagValue(argv, "--name");
      const fnArg = positional[0];
      let result;
      if (nameArg !== undefined) {
        result = svc.whoCallsByName({ name: nameArg }, { all });
      } else if (fnArg !== undefined) {
        const fn = fnArg.startsWith("fn:") ? Number(fnArg.slice(3)) : Number(fnArg);
        result = svc.whoCallsByName({ fn }, { all });
      } else {
        fail(ErrorCode.E_USAGE, "query who-calls-by-name <fn:N | --name X> …", 2, json);
        return;
      }
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const n of result.names) {
          if (n.ambiguous) process.stdout.write(`! name "${n.name}" ambiguous: ${n.why}\n`);
          else if (n.sid === null) process.stdout.write(`- name "${n.name}": ${n.why}\n`);
          else process.stdout.write(`# name "${n.name}" (sid:${n.sid})\n`);
        }
        for (const r of result.rows) process.stdout.write(`fn:${r.fn} name:${r.name} ${r.role} n:${r.n} ${r.file ?? "-"}:${r.line ?? "-"} confidence:${r.confidence}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
        if (result.excludedModule !== null) process.stdout.write(`excluded exporting module: ${result.excludedModule}\n`);
      }
    } else if (verb === "object-tables") {
      // Bundle-wide inventory of constant object literals (spec 10 §3.1;
      // docs/specs/hunt-tooling-backlog.md "endpoint-tables"). Live verb:
      // the literal buffers are bytecode, so this needs `--hbc`.
      const num = (flag: string): number | undefined => {
        const v = flagValue(argv, flag);
        return v === undefined ? undefined : Number(v);
      };
      const result = svc.objectTables({
        ...(num("--min-props") !== undefined ? { minProps: num("--min-props")! } : {}),
        ...(num("--string-ratio") !== undefined ? { stringRatio: num("--string-ratio")! } : {}),
        ...(num("--module") !== undefined ? { module: num("--module")! } : {}),
        ...(num("--min-matched") !== undefined ? { minMatched: num("--min-matched")! } : {}),
        ...(num("--limit") !== undefined ? { limit: num("--limit")! } : {}),
        ...(flagValue(argv, "--key") !== undefined ? { key: flagValue(argv, "--key")! } : {}),
        ...(flagValue(argv, "--value") !== undefined ? { value: flagValue(argv, "--value")! } : {}),
        ...(all ? { limit: Number.MAX_SAFE_INTEGER } : {}),
      });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const t of result.tables) {
          process.stdout.write(`fn ${t.fn} @${t.offset}  module ${t.module ?? "-"}  keys=${t.members.length} strings=${t.strings} matched=${t.matched}\n`);
          for (const m of t.members.slice(0, MEMBER_LINES)) {
            process.stdout.write(`  ${m.key}: ${m.kind === "string" ? m.value : m.kind === "computed" ? "<computed>" : `<${m.kind}>`}\n`);
          }
          if (t.members.length > MEMBER_LINES) process.stdout.write(`  … (+${t.members.length - MEMBER_LINES} more)\n`);
        }
        const tl = truncationLine(result.total, result.tables.length, "--limit N or --all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total} scanned:${result.scanned}\n`);
      }
    } else if (verb === "string") {
      const sid = Number(positional[0]);
      const showFull = argv.includes("--full");
      const { value, uses } = svc.string(sid);
      if (json) {
        process.stdout.write(JSON.stringify({ value, uses }) + "\n");
      } else {
        if (value === undefined) process.stdout.write(`sid:${sid} <no such string>\n`);
        else if ("v" in value) process.stdout.write(`${value.v}\n`);
        else process.stdout.write(showFull ? `${value.head}… [truncated, len:${value.len} sha256:${value.sha256}]\n` : `${value.head}… [head only, len:${value.len}; use --full]\n`);
        for (const u of uses.rows) process.stdout.write(`fn:${u.fn} ${u.role} n:${u.n}\n`);
        const tl = truncationLine(uses.total, uses.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
      }
    } else if (verb === "string-grep") {
      const result = svc.stringGrep(positional[0] as string, { all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`${r.sid}  ${r.head}  ${r.uses}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "global-uses") {
      const result = svc.globalUses(positional[0] as string, { all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`fn:${r.fn} ${r.access} n:${r.n} ${r.file ?? "-"}:${r.line ?? "-"}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "native") {
      const fnFilter = flagValue(argv, "--fn");
      const result = svc.native({ ...(fnFilter !== undefined ? { fn: Number(fnFilter) } : {}), all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`fn:${r.fn} ${r.surface} ${r.name} n:${r.n}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "module") {
      const result = svc.module(Number(positional[0]));
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else
        process.stdout.write(
          `file:${result.file ?? "-"}\ndeps:${result.deps.join(",") || "-"}\ndependents:${result.dependents.join(",") || "-"}\nownedFnCount:${result.ownedFnCount}\n`,
        );
    } else if (verb === "source") {
      const fn = Number(positional[0]);
      const linesArg = flagValue(argv, "--lines");
      const range = linesArg !== undefined ? (linesArg.split("-").map(Number) as [number, number]) : undefined;
      process.stdout.write(svc.source(fn, range) + "\n");
    } else {
      fail(ErrorCode.E_USAGE, "query <fn|who-calls|who-calls-by-name|calls-from|string|string-grep|global-uses|native|object-tables|module|source> …", 2, json);
    }
    process.exit(0);
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// `hbc2js project <verb> …` — docs/specs/11-project-store.md §3, §7 step 5.
// A thin formatting wrapper over `ProjectService`, same split as `query`'s
// CLI is over `ArtifactService` — the caps/truncation markers here present
// `ProjectService`'s already-bounded row sets, never a second source of
// truth for the §3.1 caps.
// ---------------------------------------------------------------------------
function requireProv(argv: readonly string[], json: boolean): Provenance {
  const source = flagValue(argv, "--prov-source");
  const who = flagValue(argv, "--prov-who");
  const run = flagValue(argv, "--prov-run");
  if (source === undefined || who === undefined || !["human", "llm", "tool"].includes(source)) {
    fail(ErrorCode.E_USAGE, "project <write-verb>: needs --prov-source <human|llm|tool> --prov-who <id> [--prov-run <id>]", 2, json);
  }
  return { source: source as Provenance["source"], who, ...(run !== undefined ? { run } : {}) };
}

/** `--evidence ref=role` (repeatable); `=` is unambiguous against the ref
 *  vocabulary's own `:`-separated prefixes (`fn:`/`reg:F:R`/`sid:`/`mod:`/
 *  `trace:`/`fuzz:`/`repro:`, none of which contain `=`). */
function parseEvidence(argv: readonly string[]): readonly EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--evidence" && i + 1 < argv.length) {
      const raw = argv[i + 1] as string;
      const eq = raw.indexOf("=");
      refs.push(eq >= 0 ? { ref: raw.slice(0, eq), role: raw.slice(eq + 1) } : { ref: raw, role: "context" });
    }
  }
  return refs;
}

function annotationLine(row: AnnotationRow): string {
  if (row.type === "tag") return `tag ${row.record.tag} ${provLine(row.record.prov)}${row.record.note !== undefined ? ` "${row.record.note}"` : ""}`;
  if (row.type === "comment") return `comment${row.record.range !== undefined ? ` L${row.record.range.line}` : ""} "${row.record.body.slice(0, 60)}"`;
  const rf: ResolvedFinding = row.record;
  return `finding#${rf.record.rid} ${rf.record.severity} ${rf.status} "${rf.record.claim.slice(0, 40)}"`;
}

function provLine(prov: Provenance): string {
  return prov.run !== undefined ? `${prov.source}@${prov.run}` : prov.source;
}

function runProject(argv: readonly string[]): void {
  const verb = argv[0];
  const sub = argv[1];
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const artifactDir = flagValue(argv, "--artifact");
  if (artifactDir === undefined) fail(ErrorCode.E_USAGE, "project <verb> --artifact <dir> …", 2, json);

  let artifact: ArtifactService;
  let svc: ProjectService;
  try {
    artifact = new ArtifactService(artifactDir);
    svc = new ProjectService(artifactDir, artifact);
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }

  const rest = argv.slice(verb === "tag" || verb === "finding" || verb === "bookmark" || verb === "comment" ? 2 : 1);
  const positional = rest.filter((a) => !a.startsWith("--"));

  try {
    if (verb === "for-fn") {
      const result = svc.forFn(Number(positional[0]), { all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`${annotationLine(r)}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "tag" && sub === "set") {
      const target = positional[0] as string;
      const tag = positional[1] as Tag;
      const note = flagValue(argv, "--note");
      const prov = requireProv(argv, json);
      const result = svc.setTag(target, tag, prov, note !== undefined ? { note } : {});
      process.stdout.write(`${result.line}\n`);
    } else if (verb === "tag" && sub === "get") {
      const result = svc.tagsOn(positional[0] as string);
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`${r.tag} ${provLine(r.prov)}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
      }
    } else if (verb === "findings") {
      const tag = flagValue(argv, "--tag");
      const severity = flagValue(argv, "--severity");
      const status = flagValue(argv, "--status");
      const result = svc.findings(
        { ...(tag !== undefined ? { tag: tag as Tag } : {}), ...(severity !== undefined ? { severity: severity as Severity } : {}), ...(status !== undefined ? { status: status as FindingStatus } : {}) },
        { all },
      );
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const rf of result.rows) process.stdout.write(`#${rf.record.rid} ${rf.record.severity} ${rf.status} ${rf.record.target} "${rf.record.claim.slice(0, 40)}"\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "finding" && sub === "show") {
      const rf = svc.finding(positional[0] as string);
      if (rf === null) fail(ErrorCode.E_USAGE, `finding show: no such finding ${positional[0]}`, 2, json);
      if (json) process.stdout.write(JSON.stringify(rf) + "\n");
      else {
        process.stdout.write(`finding#${rf.record.rid} ${rf.record.severity} ${rf.status} ${rf.record.target} valid:${rf.valid}\n`);
        process.stdout.write(`claim: ${rf.record.claim}\n`);
        for (const e of rf.refs) process.stdout.write(`evidence ${e.ref.ref} [${e.ref.role}] resolved:${e.resolved}\n`);
      }
    } else if (verb === "finding" && sub === "add") {
      const target = positional[0] as string;
      const claim = flagValue(argv, "--claim") ?? "";
      const severity = (flagValue(argv, "--severity") ?? "low") as Severity;
      const cwe = flagValue(argv, "--cwe");
      const prov = requireProv(argv, json);
      const evidence = parseEvidence(argv);
      const result = svc.addFinding({ target, claim, severity, evidence, prov, ...(cwe !== undefined ? { cwe } : {}) });
      process.stdout.write(`${result.line}\n`);
    } else if (verb === "finding" && sub === "set-status") {
      const rid = positional[0] as string;
      const to = positional[1] as FindingStatus;
      const prov = requireProv(argv, json);
      const evidence = parseEvidence(argv);
      const result = svc.setFindingStatus(rid, to, evidence, prov);
      process.stdout.write(`${result.line}\n`);
    } else if (verb === "comment" && sub === "add") {
      const target = positional[0] as string;
      const body = flagValue(argv, "--body") ?? "";
      const rangeArg = flagValue(argv, "--range");
      const prov = requireProv(argv, json);
      const range = rangeArg !== undefined ? (rangeArg.includes(":") ? { line: Number(rangeArg.split(":")[0]), col: Number(rangeArg.split(":")[1]) } : { line: Number(rangeArg) }) : undefined;
      const result = svc.addComment(target, body, prov, range !== undefined ? { range } : {});
      process.stdout.write(`${result.line}\n`);
    } else if (verb === "comments") {
      const result = svc.comments(Number(positional[0]), { all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`${r.rid}${r.range !== undefined ? ` L${r.range.line}` : ""} "${r.body.slice(0, 60)}"\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "bookmark" && sub === "add") {
      const target = positional[0] as string;
      const label = flagValue(argv, "--label");
      const prov = requireProv(argv, json);
      const result = svc.addBookmark(target, prov, label !== undefined ? { label } : {});
      process.stdout.write(`${result.line}\n`);
    } else if (verb === "bookmarks") {
      const fnFilter = flagValue(argv, "--fn");
      const result = svc.bookmarks(fnFilter !== undefined ? { fn: Number(fnFilter) } : {}, { all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`${r.target}${r.label !== undefined ? ` "${r.label}"` : ""}\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "orphans") {
      const result = svc.orphans({ all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) {
          const ctxBits = [r.ctx.name, r.ctx.loc, r.ctx.ownerFn].filter((x) => x !== undefined).join(" ");
          process.stdout.write(`${r.kind}#${r.rid} ${r.target}${ctxBits !== "" ? ` [${ctxBits}]` : ""}\n`);
        }
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "conflicts") {
      const result = svc.conflicts({ all });
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else {
        for (const r of result.rows) process.stdout.write(`conflict#${r.record.rid} ${r.file} ${r.record.target} rids:[${r.record.rids.join(",")}]\n`);
        const tl = truncationLine(result.total, result.rows.length, "--all");
        if (tl !== null) process.stdout.write(`${tl}\n`);
        process.stdout.write(`total:${result.total}\n`);
      }
    } else if (verb === "merge") {
      const otherDir = positional[0];
      if (otherDir === undefined) fail(ErrorCode.E_USAGE, "project merge <otherArtifactDir>", 2, json);
      const result = svc.mergeFrom(otherDir as string);
      if (json) process.stdout.write(JSON.stringify(result) + "\n");
      else process.stdout.write(`merged ${otherDir}: conflicts:${result.conflictCount}\n`);
    } else if (verb === "stat") {
      const s = svc.stat();
      if (json) process.stdout.write(JSON.stringify(s) + "\n");
      else {
        process.stdout.write(`comments:${s.comments} tags:${s.tags} bookmarks:${s.bookmarks} findings:${s.findings}\n`);
        process.stdout.write(`invalidFindings:${s.invalidFindings} orphans:${s.orphans} conflicts:${s.conflicts}\n`);
      }
    } else {
      fail(
        ErrorCode.E_USAGE,
        "project <for-fn|tag set|tag get|findings|finding show|finding add|finding set-status|comment add|comments|bookmark add|bookmarks|orphans|conflicts|merge <dir>|stat> …",
        2,
        json,
      );
    }
    process.exit(0);
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }
}

/** `hbc2js secrets <verb> --artifact <dir> …` (spec 12 §5). Every verb here
 *  is a read over `SecretsService`'s own bounds (§5's table) — `scan` is the
 *  one verb that writes, and it self-provenances its findings as
 *  `prov.source:"tool"` inside `SecretsService.scan()` (module header), so
 *  unlike `project`'s write verbs this command never needs `--prov-*`
 *  flags. `show`/`hosts`/`paths` need the artifact ROOT `SecretsService`
 *  already resolves against (deliverable 1 of this step's layout fix);
 *  `hosts`/`paths` are honestly empty until the spec-11 tag taxonomy lands
 *  (module header in src/secrets/service.ts) — not a bug in this wiring. */
function runSecrets(argv: readonly string[]): void {
  const verb = argv[0];
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  const artifactDir = flagValue(argv, "--artifact");
  if (artifactDir === undefined) fail(ErrorCode.E_USAGE, "secrets <verb> --artifact <dir> …", 2, json);

  let svc: SecretsService;
  try {
    svc = new SecretsService({ artifactDir });
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }

  const positional = argv.slice(1).filter((a) => !a.startsWith("--"));

  try {
    if (verb === "scan") {
      const summary = svc.scan({ force });
      if (json) process.stdout.write(JSON.stringify(summary) + "\n");
      else {
        process.stdout.write(
          `secrets scan: ${summary.new} new, ${summary.cached} cached, ${summary.skippedRefuted} refuted-skipped, ` +
            `${summary.total} strings scanned (${summary.wallTimeMs}ms)\n`,
        );
      }
    } else if (verb === "report") {
      const lines = svc.report();
      if (json) process.stdout.write(JSON.stringify({ lines }) + "\n");
      else for (const l of lines) process.stdout.write(`${l}\n`);
    } else if (verb === "list") {
      const category = flagValue(argv, "--category");
      const tier = flagValue(argv, "--tier");
      const rows = svc.list({ ...(category !== undefined ? { category } : {}), ...(tier !== undefined ? { tier: tier as SecretTier } : {}) });
      if (json) process.stdout.write(JSON.stringify({ rows, total: rows.length }) + "\n");
      else {
        for (const r of rows) {
          const patternId = r.ctx.patternId ?? "";
          const uses = r.evidence.filter((e) => e.role === "use-site").length;
          process.stdout.write(`#${r.id} ${r.ctx.tier ?? "-"} ${r.severity} ${r.target} uses:${uses} ${patternId}\n`);
        }
        process.stdout.write(`total:${rows.length}\n`);
      }
    } else if (verb === "show") {
      const id = positional[0];
      if (id === undefined) fail(ErrorCode.E_USAGE, "secrets show <finding-id> --artifact <dir>", 2, json);
      const row = svc.list().find((r) => r.id === id);
      if (row === undefined) fail(ErrorCode.E_USAGE, `secrets show: no such finding ${id}`, 2, json);
      if (json) process.stdout.write(JSON.stringify(row) + "\n");
      else {
        process.stdout.write(`finding#${row!.id} ${row!.ctx.tier ?? "-"} ${row!.severity} ${row!.status} ${row!.target}\n`);
        for (const e of row!.evidence) {
          const span = e.span !== undefined ? ` span=[${e.span[0]},${e.span[1]}]` : "";
          process.stdout.write(`evidence ${e.ref} [${e.role}]${span}${e.note !== undefined ? ` ${e.note}` : ""}\n`);
        }
      }
    } else if (verb === "hosts") {
      const rows = svc.hosts();
      if (json) process.stdout.write(JSON.stringify({ rows, total: rows.length }) + "\n");
      else {
        for (const r of rows) process.stdout.write(`${r.host}  paths:${r.paths}  fns:${r.fns}\n`);
        process.stdout.write(`total:${rows.length}\n`);
      }
    } else if (verb === "paths") {
      const host = positional[0];
      if (host === undefined) fail(ErrorCode.E_USAGE, "secrets paths <host> --artifact <dir>", 2, json);
      const rows = svc.paths(host as string);
      if (json) process.stdout.write(JSON.stringify({ rows, total: rows.length }) + "\n");
      else {
        for (const r of rows) process.stdout.write(`${r.path}  fn:${r.fn}\n`);
        process.stdout.write(`total:${rows.length}\n`);
      }
    } else {
      fail(ErrorCode.E_USAGE, "secrets <scan [--force]|report|list [--category c] [--tier t]|show <id>|hosts|paths <host>> --artifact <dir> …", 2, json);
    }
    process.exit(0);
  } catch (e) {
    const err = e instanceof Hbc2jsError ? e : new Hbc2jsError(ErrorCode.E_INTERNAL, e instanceof Error ? e.message : String(e));
    if (json) process.stdout.write(JSON.stringify(err.toJSON()) + "\n");
    else process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }
}

function runRender(argv: readonly string[]): void {
  const hbc = flagValue(argv, "--hbc") ?? argv.find((a) => !a.startsWith("-") && a.endsWith(".hbc"));
  if (hbc === undefined) fail(ErrorCode.E_USAGE, "render --hbc <input.hbc> [--fn N] [--store <path>] [--out <file>]", 2, false);
  const storePath = defaultStorePath(hbc, flagValue(argv, "--store"));
  const store = OverlayStore.load(storePath, hbc);
  const svc = new NameService(buildAnalysis(hbc), store);
  const fnStr = flagValue(argv, "--fn");
  const out = svc.render(fnStr !== undefined ? { fn: Number(fnStr) } : {});
  for (const c of out.collisions) {
    process.stderr.write(`hbc2js render: collision in fn ${c.id.fn}: wanted "${c.wanted}", emitted "${c.rendered}"\n`);
    store.flagCollision(c.id, c.rendered);
  }
  if (out.collisions.length > 0) store.save(storePath);
  const outPath = flagValue(argv, "--out");
  if (outPath !== undefined) writeFileSync(outPath, out.code);
  else process.stdout.write(out.code);
  process.exit(0);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "name") {
    runNameOverlay(argv.slice(1));
    return;
  }
  if (argv[0] === "render") {
    runRender(argv.slice(1));
    return;
  }
  if (argv[0] === "query") {
    runQuery(argv.slice(1));
    return;
  }
  if (argv[0] === "project") {
    runProject(argv.slice(1));
    return;
  }
  if (argv[0] === "secrets") {
    runSecrets(argv.slice(1));
    return;
  }
  if (argv[0] === "segregate") {
    process.exitCode = runSegregateCmd(argv.slice(1));
    return;
  }
  if (argv[0] === "init") {
    process.exitCode = runInit(argv.slice(1));
    return;
  }
  if (argv[0] === "hbcproj") {
    process.exitCode = runHbcproj(argv.slice(1));
    return;
  }
  if (argv[0] === "ui-server") {
    void runUiServer(argv.slice(1)).then((code) => {
      process.exitCode = code;
    });
    return;
  }
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
  if (argv[0] === "deps") {
    // `process.exitCode`, not `process.exit()`: a piped stdout is async in
    // Node, and exiting early truncates `--json` output at the 64 KB pipe
    // buffer (docs/BUGS.md; regression test in tests/gate/cli/deps.test.ts).
    void runDepsCmd(argv.slice(1)).then((code) => {
      process.exitCode = code;
    });
    return;
  }
  // `hbc2js <input.hbc> [out.js]` is the default command; `--info` and the other
  // subcommands keep their existing behaviour (additive, per this milestone's
  // task boundary).
  if (argv.includes("--list-passes")) {
    process.stdout.write(`${describePasses()}\n`);
    return;
  }
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-") && argv.every((a) => a !== "--info")) {
    runDecompile(argv);
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
