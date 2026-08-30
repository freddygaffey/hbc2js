#!/usr/bin/env node
// tools/pkgsig/build-signatures.mjs — T8 prototype v2 (docs/PACKAGE-SIGNATURES.md §5).
//
// Low-level fingerprinter: turns one already-compiled `.hbc` into a v2
// signature-DB JSON (functions + recovered `__d()` modules, no provenance
// beyond what's passed on the command line). `build-db.mjs` is the
// end-to-end tool (bundle -> compile -> fingerprint -> write into
// tools/pkgsig/db/ with full provenance) and calls the same
// tools/pkgsig/lib/fingerprint.mjs this does; this script stays around as
// the direct "I already have a .hbc" entry point — used for the baseline
// probes (§5.1) and for ad hoc/manual fingerprinting.
//
// Usage:
//   node --experimental-strip-types build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json> [--baseline]
//
// --experimental-strip-types is needed because this dynamically imports
// .ts files from src/** (parser/disassembler only — see fingerprint.mjs's
// header for why the normaliser itself is pkgsig's own fork, not an import).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprintModule } from "./lib/fingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const { parseHbc } = await import(join(repoRoot, "src", "index.ts"));
const { decodeFunction } = await import(join(repoRoot, "src", "disasm", "decode.ts"));

function main() {
  const args = process.argv.slice(2);
  const isBaseline = args.includes("--baseline");
  const posArgs = args.filter((a) => !a.startsWith("--"));
  const [inPath, pkgName, pkgVersion, outPath] = posArgs;
  if (!inPath || !pkgName || !pkgVersion || !outPath) {
    console.error("usage: build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json> [--baseline]");
    process.exit(2);
  }

  const bytes = new Uint8Array(readFileSync(inPath));
  const mod = parseHbc(bytes);
  const { functions, modules } = fingerprintModule(mod, decodeFunction);

  const db = {
    schema: 2,
    package: pkgName,
    version: pkgVersion,
    hbcVersion: mod.header.version,
    sourceFile: inPath,
    totalFunctions: functions.length,
    functions,
    modules,
    toolchainBaseline: isBaseline,
  };
  writeFileSync(outPath, JSON.stringify(db));
  console.log(`${pkgName}@${pkgVersion}: ${functions.length} functions, ${modules.length} __d() modules -> ${outPath}`);
}

main();
