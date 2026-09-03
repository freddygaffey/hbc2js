#!/usr/bin/env node
// tools/security/build-vulnapp-sigdb.ts — spec 13 (P2.4 reuse-validation)
// §9 step 2. Generates the project-local signature-DB files
// (`src/deps/sigdb-types.ts` schema 2) for the vuln-app fixture's 3 Lane O
// dependency stand-ins (`tests/fixtures/security/vuln-app/source/App.js`'s
// `__d(...)`-wrapped synthetic lodash/minimist/axios factories, spec 13
// §8.2 "extends the §2.3 fixture's build").
//
// This is the fixture's own build hook, not part of the OSV adapter: run it
// whenever `source/App.js`'s synthetic factories change, same convention as
// `build.sh` regenerating `v96.hbc`. Output: one
// `<pkg>@<version>__hbc96.json` file per package under
// `tests/fixtures/security/vuln-app/sigdb/`, containing the FACTORY
// function's own fingerprint (`src/deps/fingerprint.ts`'s `fingerprintModule`,
// the SAME normalisation `hbc2js deps` uses at match time) both as a
// function-level AND a module-level (`SigModule.factoryExactHash`) entry --
// so it exact-hash-matches its own compiled bytecode at both granularities,
// which is what lets `hbc2js deps`'s real match pipeline populate
// `DepsReport.moduleOwnership` (the `mod:<localModuleId>` anchor the OSV
// adapter's findings resolve evidence against, spec 13 §3.3). This is
// self-consistent plumbing (proves the two-key gate's High-tier + exact-
// hash-version path end to end against a real `hbc2js deps` run), not a
// claim that these bytes are real lodash/minimist/axios code -- see
// README.md and App.js's own header comment on the stand-ins.
//
// The distinguishing code lives directly in each factory body (not a nested
// closure): `normaliseFunctionForSignature` masks string-literal CONTENT
// (by design -- a signature must survive minor string changes between
// patch releases), so a generic "declare a const, create one closure,
// return it" outer shape would hash identically across all three stand-ins
// regardless of what a nested closure did -- discovered hands-on building
// this script (first attempt fingerprinted a nested helper and all three
// factories collided on the same 3-instruction outer-shape hash, and
// separately never populated `moduleOwnership` because module-level
// attribution keys off the FACTORY's own hash, not a nested function's).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHbc } from "../../src/parse/module.ts";
import { decodeFunction } from "../../src/disasm/decode.ts";
import { scanModuleRegistrations } from "../../src/deps/dscan.ts";
import { fingerprintModule } from "../../src/deps/fingerprint.ts";
import type { SigDbFile, SigFunction, SigModule } from "../../src/deps/sigdb-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", "tests", "fixtures", "security", "vuln-app");
const HBC_PATH = join(FIXTURE_DIR, "v96.hbc");
const SIGDB_DIR = join(FIXTURE_DIR, "sigdb");

// moduleId (the __d() second argument in App.js) -> {package, version}, per
// the lockfile pins (tests/fixtures/security/vuln-app/lockfile.json /
// ground-truth.json's lockfilePins).
const STAND_INS: Record<number, { readonly pkg: string; readonly version: string }> = {
  9001: { pkg: "lodash", version: "4.17.15" },
  9002: { pkg: "minimist", version: "0.0.8" },
  9003: { pkg: "axios", version: "0.21.0" },
};

function main(): void {
  const bytes = new Uint8Array(readFileSync(HBC_PATH));
  const mod = parseHbc(bytes);
  const globalFn = decodeFunction(mod, 0);
  const regs = scanModuleRegistrations(mod, globalFn);
  const { functions, modules } = fingerprintModule(mod, decodeFunction);
  const byIndex = new Map(functions.map((f) => [f.index, f]));
  const moduleByFactoryIndex = new Map(modules.map((m) => [m.factoryFunctionIndex, m]));

  mkdirSync(SIGDB_DIR, { recursive: true });

  let written = 0;
  for (const reg of regs) {
    const standIn = reg.moduleId !== null ? STAND_INS[reg.moduleId] : undefined;
    if (standIn === undefined) continue;
    const factory = byIndex.get(reg.factoryFunctionIndex);
    const sigModule = moduleByFactoryIndex.get(reg.factoryFunctionIndex);
    if (factory === undefined || sigModule === undefined) throw new Error(`no fingerprint for factory fn#${reg.factoryFunctionIndex} (moduleId ${reg.moduleId}) -- did App.js's stand-in shape change?`);
    const sigFn: SigFunction = { ...factory };
    const sigMod: SigModule = {
      factoryFunctionIndex: sigModule.factoryFunctionIndex,
      localModuleId: sigModule.localModuleId,
      depCount: sigModule.depCount,
      depIds: sigModule.depIds,
      factoryExactHash: sigModule.factoryExactHash,
      factoryFuzzyHash: sigModule.factoryFuzzyHash,
      nestedFunctionCount: sigModule.nestedFunctionCount,
      functionSetHash: sigModule.functionSetHash,
      factoryIsBaseline: false,
    };
    const file: SigDbFile = {
      schema: 2,
      package: standIn.pkg,
      version: standIn.version,
      hbcVersion: 96,
      totalFunctions: mod.functions.length,
      rawFunctionCount: 1,
      subtractedBaselines: [],
      functions: [sigFn],
      modules: [sigMod],
      toolchainBaseline: false,
      provenance: {
        packageSha256: null,
        metroVersion: null,
        reactNativeVersion: null,
        hermescVersion: 96,
        hermescRnEra: null,
        repoCommit: null,
        builtAt: new Date().toISOString(),
      },
    };
    const outPath = join(SIGDB_DIR, `${standIn.pkg}@${standIn.version}__hbc96.json`);
    writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n");
    written++;
    console.log(`OK   ${standIn.pkg}@${standIn.version} <- factory fn#${reg.factoryFunctionIndex} (moduleId ${reg.moduleId}, instrCount ${sigFn.instrCount}) -> ${outPath}`);
  }
  if (written !== Object.keys(STAND_INS).length) {
    throw new Error(`expected ${Object.keys(STAND_INS).length} stand-in module registrations recovered from ${HBC_PATH}, got ${written} -- did App.js's __d() shapes change?`);
  }
}

main();
