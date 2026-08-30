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

const USAGE = `hbc2js ${VERSION} — Hermes bytecode (HBC) -> JavaScript decompiler

Usage:
  hbc2js --info <input.hbc>        print header/layout/section info and exit
  hbc2js disasm <input.hbc> [options]   disassemble to text (spec 02)
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

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "disasm") {
    runDisasm(argv.slice(1));
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
