#!/usr/bin/env node
// tools/pkgsig/filter-unsubtracted.mjs — post-extraction data-hygiene pass
// for a fetched D17c bulk signature-DB archive (docs/PACKAGE-SIGNATURES.md
// §6.7). `fetch-db.sh` runs this automatically after extracting an archive;
// it's also safe to run by hand against any existing sigdb directory.
//
// Why this exists (found 2026-08-31, layering the first published bulk
// archive `sigdb-20260830-partial.tar.zst` for issue #14's baseline
// measurement): `tools/pkgsig/bulk/baseline-subtract.mjs`'s own header
// explains the risk it exists to prevent — a raw per-package fingerprint
// always includes Metro's own require-runtime plus, when the build scaffold
// pulled it in, the whole of react/react-native, since Metro has no
// export-level tree-shaking (docs/PACKAGE-SIGNATURES.md §2.1/§5.2). Every
// package DB is supposed to have that baseline subtracted out before it's
// usable; `SigDbFile.subtractedBaselines` (non-empty for a correctly-built,
// non-baseline file) is the on-disk record that it happened.
//
// 353 of the 32,708 files in that first "partial" archive (1.1%) have
// `subtractedBaselines: []` on a non-baseline package — the subtraction step
// silently didn't run for them (a partial/interrupted build, per the
// archive's own filename). Measured effect of loading one of them
// unfiltered: `@amplitude/react-native@2.17.0__hbc94.json` carries 4,244
// functions, of which 4,150 are an untouched copy of react/react-native's
// own internals (verified: exact-hash-matches 4,150/4,199 of the committed
// `rn-template-0.72` fixture, which has NO dependency on `@amplitude/react-native`
// at all) — layering the archive as-is turned a clean 2-confirmed-dependency
// report into 134 confirmed "dependencies", 133 of them false positives,
// entirely from this handful of contaminated files' baseline-sized function
// sets winning exact-hash collisions against every real RN bundle's own
// react-native code. This is exactly the failure mode
// `baseline-subtract.mjs`'s own header describes; these particular files
// just never went through it.
//
// This script quarantines any non-baseline file with an empty
// `subtractedBaselines` array into `<dir>/_rejected-unsubtracted/` (kept for
// audit, never read by `src/deps/db.ts`'s `loadSignatures`, which only reads
// `<dir>/*.json` and `<dir>/_baselines/*.json`) rather than deleting them
// outright, and updates `index.json` to drop their entries. Intentionally
// NOT a change to `src/deps/db.ts` itself: `loadSignatures` is exercised by
// dozens of gate tests with minimal hand-written fixtures that don't bother
// populating `subtractedBaselines` (it's irrelevant to what they test), and
// `confirmCandidates` can legitimately produce an empty-subtraction
// signature when no baseline files are reachable in any DB layer yet (a
// cold `--confirm` run before any baseline has been seeded) — neither of
// those is the "silently shipped contaminated data" case this script exists
// to catch, so the check belongs at bulk-archive ingestion time, not as a
// blanket load-time policy.
//
// Usage: node tools/pkgsig/filter-unsubtracted.mjs <sigdb-dir>

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function filterUnsubtracted(dir) {
  const rejectedDir = join(dir, "_rejected-unsubtracted");
  const rejected = [];
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "index.json");
  for (const name of names) {
    const path = join(dir, name);
    let file;
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // not this script's job to validate JSON well-formedness
    }
    if (file.toolchainBaseline === true) continue; // baseline files have nothing to subtract from themselves
    if (Array.isArray(file.subtractedBaselines) && file.subtractedBaselines.length > 0) continue;
    mkdirSync(rejectedDir, { recursive: true });
    renameSync(path, join(rejectedDir, name));
    rejected.push({ package: file.package, version: file.version, hbcVersion: file.hbcVersion, functionCount: Array.isArray(file.functions) ? file.functions.length : null });
  }
  const indexPath = join(dir, "index.json");
  if (rejected.length > 0 && existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const rejectedKeys = new Set(rejected.map((r) => `${r.package}@${r.version}__hbc${r.hbcVersion}`));
      index.entries = (index.entries ?? []).filter((e) => !rejectedKeys.has(`${e.package}@${e.version}__hbc${e.hbcVersion}`));
      writeFileSync(indexPath, JSON.stringify(index, null, 1));
    } catch {
      // index.json is a convenience manifest, not load-bearing for
      // `loadSignatures` (which lists the directory itself) — a failure
      // here doesn't leave the DB unsafe, just the manifest stale.
    }
  }
  return rejected;
}

async function main(argv) {
  const dir = argv[0];
  if (dir === undefined) {
    process.stderr.write("usage: filter-unsubtracted.mjs <sigdb-dir>\n");
    return 2;
  }
  const rejected = filterUnsubtracted(dir);
  if (rejected.length === 0) {
    process.stdout.write("filter-unsubtracted: no unsubtracted (baseline-contaminated) files found\n");
  } else {
    process.stdout.write(`filter-unsubtracted: quarantined ${rejected.length} unsubtracted file(s) into ${join(dir, "_rejected-unsubtracted")}/ (not read by hbc2js deps):\n`);
    for (const r of rejected.slice(0, 20)) process.stdout.write(`  ${r.package}@${r.version}__hbc${r.hbcVersion} (${r.functionCount} functions, unsubtracted)\n`);
    if (rejected.length > 20) process.stdout.write(`  ... and ${rejected.length - 20} more\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
