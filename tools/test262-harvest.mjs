#!/usr/bin/env node
// tools/test262-harvest.mjs — T2: curated test262 subset harvester.
//
// test262 (tc39/test262) is BSD-3-Clause. It is a conformance suite, not a
// curated single-program corpus (docs/TEST-CORPUS.md §1b calls it "a large
// but low-density edge-case reservoir to dip into rather than" swallow
// whole), so this script picks ~200 tests from a fixed, documented set of
// directories on control flow, generators, try/finally and closures, turns
// each into one or more runnable plain-JS files (harness concatenated in per
// test262's own frontmatter contract), and writes the result — plus a
// manifest and the licence — under tests/sweep/test262/.
//
// Usage:
//   node tools/test262-harvest.mjs --src <path-to-test262-checkout> [--out tests/sweep/test262]
//
// The full test262 checkout is NOT vendored into this repo (harness/ +
// test/language/ + test/built-ins/ alone run >100MB). Get a sparse checkout
// first:
//
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/tc39/test262.git /tmp/test262
//   cd /tmp/test262 && git sparse-checkout set harness test/language test/built-ins
//
// then re-run this script with --src /tmp/test262 whenever CATEGORIES below
// changes. The script is idempotent: it deletes and regenerates
// <out>/cases/ and <out>/manifest.json on every run, so nothing here needs
// hand-editing after a re-harvest.
//
// ---------------------------------------------------------------------------
// Selection
//
// CATEGORIES below lists, per named category, the test262 directories to
// draw from and a per-directory cap. Each directory's *.js files (recursive,
// `*_FIXTURE.js` excluded per test262's own contract — those are includes for
// other tests, not standalone tests) are sorted by relative path for
// determinism. For the "closures" category, filenames matching
// /scope|closure|nested|capture/i are taken first within a directory (there
// is no dedicated test262 "closures" directory — expressions/function,
// arrow-function and statements/function are the closest proxies, and most
// of their tests are about function syntax rather than variable capture, so
// this prioritisation biases the pick toward tests that actually exercise a
// closure), then the directory is filled up to its cap alphabetically.
//
// Excluded by flag, with reason (recorded per-file in manifest.json under
// `excluded`, and tallied in the printed summary):
//   module — running ESM source needs a module loader this harness does not
//            wire up; out of scope for this pass.
//   async  — needs harness/doneprintHandle.js's $DONE callback plus a
//            timeout/idle protocol our plain `node file.js` runner does not
//            implement; out of scope for this pass.
// Everything else, `raw` and `negative` included, is harvested — see below.
//
// ---------------------------------------------------------------------------
// Per-file generation
//
// `flags:` controls how many files a selected test becomes and what's
// prepended, per test262's own INTERPRETING.md:
//   default (neither onlyStrict/noStrict/raw) -> two files, ".sloppy.cjs" and
//     ".strict.cjs" (the spec requires running once in each mode)
//   onlyStrict -> one file, ".strict.cjs"
//   noStrict   -> one file, ".sloppy.cjs"
//   raw        -> one file, ".raw.cjs" — verbatim source only, no harness, no
//                 "use strict" (raw's own contract: "must not be modified in
//                 any way, files from harness/ must not be evaluated")
// The extension is .cjs, not .js: this repo's package.json sets "type":
// "module", so a bare .js here would run as an ES module if ever loaded via
// Node's module system directly. It never is — see below — but .cjs is the
// more honest label for what these files' *content* actually is (a Script,
// not a Module), and keeps a manual `node <file>` closer to correct.
//
// Non-raw files are assembled in the spec's mandated order: harness/assert.js
// + harness/sta.js, then each `includes:` file in the order given, then (for
// the strict variant) a "use strict";\n prologue, then this repo's print
// shim (`globalThis.print ??= (...a)=>console.log(...a);`, exactly as used in
// tests/fixtures/build.sh), then the test source verbatim.
//
// `negative: {phase, type}` tests are NOT rewritten with a try/catch — the
// harness+source concatenation is run as one file exactly like any other
// test, and the expectation (recorded per-file in manifest.json's `negative`
// field, checked by both this script's own verification pass below and by
// tests/sweep/test262/corpus.test.ts) is that running it ends in an uncaught
// exception whose constructor name is `type` (phase "runtime"), or, for
// phase "parse", that it fails to *compile* before anything runs — which a
// real SyntaxError in the test body naturally produces.
//
// Execution, both here and in corpus.test.ts, is via
// tests/sweep/test262/support/run-case.mjs's vm.Script + vm.createContext,
// NOT `node <file>` as a child process — see that file's header for why a
// plain Node module load (CommonJS *or* ESM) gets top-level `this` and
// `var`-hoisting-to-global wrong for what a test262 Script-goal test expects.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRINT_SHIM = "globalThis.print ??= (...a)=>console.log(...a);\n";

const CATEGORIES = [
  {
    name: "control-flow",
    perDir: 9,
    dirs: [
      "test/language/statements/if",
      "test/language/statements/switch",
      "test/language/statements/for",
      "test/language/statements/for-in",
      "test/language/statements/for-of",
      "test/language/statements/while",
      "test/language/statements/do-while",
      "test/language/statements/break",
      "test/language/statements/continue",
      "test/language/statements/labeled",
    ],
  },
  {
    name: "generators",
    perDir: 15,
    dirs: [
      "test/language/statements/generators",
      "test/language/expressions/generators",
      "test/built-ins/GeneratorFunction",
    ],
  },
  {
    name: "try-finally",
    perDir: 30,
    dirs: ["test/language/statements/try"],
  },
  {
    name: "closures",
    perDir: 9,
    prioritise: /scope|closure|nested|capture/i,
    dirs: ["test/language/expressions/function", "test/language/expressions/arrow-function", "test/language/statements/function"],
  },
];

function parseArgs(argv) {
  const out = { src: undefined, out: "tests/sweep/test262" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") out.src = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

function repoRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

function listJsFiles(dir) {
  const results = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE")) results.push(p);
    }
  };
  walk(dir);
  return results;
}

/** test262's frontmatter is a constrained YAML subset: single-line flow
 *  sequences for `flags`/`includes`/`features`, a 2-key block mapping for
 *  `negative`. A general YAML parser is not needed for this shape. */
function parseFrontmatter(source) {
  const m = source.match(/\/\*---([\s\S]*?)---\*\//);
  if (!m) return { flags: [], includes: [], negative: null, features: [] };
  const block = m[1];
  const flags = parseFlowList(block, "flags");
  const includes = parseFlowList(block, "includes");
  const features = parseFlowList(block, "features");
  const negMatch = block.match(/negative:\s*\n\s*phase:\s*(\S+)\s*\n\s*type:\s*(\S+)/);
  const negative = negMatch ? { phase: negMatch[1], type: negMatch[2] } : null;
  return { flags, includes, negative, features };
}

function parseFlowList(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every *.js in relDir (recursive, `_FIXTURE` excluded), in the order the
 *  harvester considers them: prioritised (closures) or plain alphabetical
 *  (relative path) otherwise. NOT capped here — module/async exclusions are
 *  discovered while walking the whole directory (see main()), so a cap
 *  applied before that walk would silently hide exclusions that happen to
 *  sort after the cap, which is exactly the flag-handling this task is
 *  supposed to demonstrate honestly. */
function listCandidates(srcRoot, relDir, prioritiseRe) {
  const abs = join(srcRoot, relDir);
  if (!existsSync(abs)) {
    console.warn(`  ! missing directory, skipping: ${relDir}`);
    return [];
  }
  let files = listJsFiles(abs)
    .map((p) => relative(srcRoot, p).split("\\").join("/"))
    .sort();
  if (prioritiseRe) {
    const hi = files.filter((f) => prioritiseRe.test(f));
    const lo = files.filter((f) => !prioritiseRe.test(f));
    files = [...hi, ...lo];
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src) {
    console.error("usage: node tools/test262-harvest.mjs --src <path-to-test262-checkout> [--out tests/sweep/test262]");
    process.exit(2);
  }
  const srcRoot = args.src;
  const root = repoRoot();
  const outDir = join(root, args.out);
  const casesDir = join(outDir, "cases");

  const licensePath = join(srcRoot, "LICENSE");
  if (!existsSync(licensePath)) {
    console.error(`no LICENSE file at ${licensePath} — refusing to harvest without confirming the licence text`);
    process.exit(2);
  }
  const licenseText = readFileSync(licensePath, "utf8");
  if (!/BSD/.test(licenseText)) {
    console.error("LICENSE at --src does not look like a BSD licence — aborting");
    process.exit(2);
  }

  let commitSha = "unknown";
  try {
    commitSha = execFileSync("git", ["-C", srcRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    console.warn("  ! could not determine test262 checkout's commit sha (not a git checkout?)");
  }

  const assertJs = readFileSync(join(srcRoot, "harness", "assert.js"), "utf8");
  const staJs = readFileSync(join(srcRoot, "harness", "sta.js"), "utf8");

  // Fresh output every run — this directory is fully generated.
  rmSync(casesDir, { recursive: true, force: true });
  mkdirSync(casesDir, { recursive: true });

  const manifest = [];
  const excludedCounts = { module: 0, async: 0 };
  const categoryCounts = {};

  for (const cat of CATEGORIES) {
    categoryCounts[cat.name] = { selected: 0, excludedModule: 0, excludedAsync: 0, filesEmitted: 0 };
    const catDir = join(casesDir, cat.name);
    mkdirSync(catDir, { recursive: true });

    for (const relDir of cat.dirs) {
      const candidates = listCandidates(srcRoot, relDir, cat.prioritise);
      let dirSelected = 0;
      for (const relPath of candidates) {
        const absPath = join(srcRoot, relPath);
        const source = readFileSync(absPath, "utf8");
        const meta = parseFrontmatter(source);

        if (meta.flags.includes("module")) {
          excludedCounts.module++;
          categoryCounts[cat.name].excludedModule++;
          manifest.push({ sourcePath: relPath, category: cat.name, excluded: "module", flags: meta.flags });
          continue;
        }
        if (meta.flags.includes("async")) {
          excludedCounts.async++;
          categoryCounts[cat.name].excludedAsync++;
          manifest.push({ sourcePath: relPath, category: cat.name, excluded: "async", flags: meta.flags });
          continue;
        }
        if (dirSelected >= cat.perDir) continue; // cap reached for this directory; keep scanning for exclusions only
        dirSelected++;

        categoryCounts[cat.name].selected++;
        const baseName = relPath.replace(/^test\//, "").replace(/\.js$/, "").split("/").join("__");

        const includesText = meta.includes
          .map((inc) => readFileSync(join(srcRoot, "harness", inc), "utf8"))
          .join("\n");

        const modes = meta.flags.includes("raw")
          ? ["raw"]
          : meta.flags.includes("onlyStrict")
            ? ["strict"]
            : meta.flags.includes("noStrict")
              ? ["sloppy"]
              : ["sloppy", "strict"];

        for (const mode of modes) {
          let body;
          if (mode === "raw") {
            body = source;
          } else {
            const strictPrologue = mode === "strict" ? '"use strict";\n' : "";
            body = [assertJs, staJs, includesText, strictPrologue, PRINT_SHIM, source].filter((s) => s.length > 0).join("\n");
          }
          // .cjs, not .js: this repo's package.json sets "type": "module", so a
          // bare .js file here would run as an ES module (implicitly strict,
          // different top-level `this`/scoping) regardless of what the test
          // actually wants. test262's sloppy/strict/raw semantics are all
          // *script* semantics, not module semantics (module: flag is excluded
          // separately, above) — .cjs pins that regardless of package.json.
          const fileName = `${baseName}.${mode}.cjs`;
          const outFile = join(catDir, fileName);
          mkdirSync(dirname(outFile), { recursive: true });
          writeFileSync(outFile, body);
          categoryCounts[cat.name].filesEmitted++;
          manifest.push({
            sourcePath: relPath,
            category: cat.name,
            mode,
            flags: meta.flags,
            includes: meta.includes,
            negative: meta.negative,
            outFile: relative(root, outFile).split("\\").join("/"),
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Empirical verification (T1 precedent): a test262 test can be spec-correct
  // and still fail under plain Node — a real V8/Node conformance gap, not a
  // property of hbc2js — most commonly an early SyntaxError test262 expects
  // that V8's parser doesn't enforce, or a strict-mode TypeError test262
  // expects that V8 doesn't raise for some Annex-B leniency. Keeping such a
  // file in the corpus would make the sweep test flap on every run for a
  // reason that has nothing to do with this project, so every generated file
  // is actually run (via tests/sweep/test262/support/run-case.mjs's
  // vm.Script/vm.createContext — true Script-goal semantics, not Node's
  // CommonJS/ESM module wrapper) and dropped, with the observed vs. expected
  // outcome recorded, if it doesn't match its frontmatter's expectation.
  const { runCase, matchesExpectation } = await import(pathToFileURL(join(root, "tests", "sweep", "test262", "support", "run-case.mjs")).href);

  const kept = [];
  const divergent = [];
  for (const entry of manifest) {
    if (entry.excluded) {
      kept.push(entry);
      continue;
    }
    const source = readFileSync(join(root, entry.outFile), "utf8");
    const result = runCase(source);
    if (matchesExpectation(entry.negative, result)) {
      kept.push(entry);
    } else {
      unlinkSync(join(root, entry.outFile));
      categoryCounts[entry.category].selected--;
      categoryCounts[entry.category].filesEmitted--;
      divergent.push({
        sourcePath: entry.sourcePath,
        category: entry.category,
        mode: entry.mode,
        expectedNegative: entry.negative,
        observed: result,
      });
    }
  }

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ test262Commit: commitSha, generatedBy: "tools/test262-harvest.mjs", manifest: kept, divergentFromNode: divergent }, null, 2) + "\n",
  );
  writeFileSync(join(outDir, "LICENSE"), licenseText);

  const totalSelected = Object.values(categoryCounts).reduce((a, c) => a + c.selected, 0);
  const totalFiles = Object.values(categoryCounts).reduce((a, c) => a + c.filesEmitted, 0);
  console.log(`test262 commit: ${commitSha}`);
  console.log(`selected ${totalSelected} tests -> ${totalFiles} runnable files (excluded ${excludedCounts.module} module, ${excludedCounts.async} async)`);
  for (const [name, c] of Object.entries(categoryCounts)) {
    console.log(`  ${name}: ${c.selected} selected (${c.excludedModule} module-excluded, ${c.excludedAsync} async-excluded) -> ${c.filesEmitted} files`);
  }
  console.log(`dropped ${divergent.length} files that diverged from their frontmatter's expectation under Node (see manifest.json's divergentFromNode)`);
  for (const d of divergent) {
    console.log(`  - ${d.sourcePath} [${d.mode}]: expected ${JSON.stringify(d.expectedNegative)}, observed ${d.observed.phase}/${d.observed.errorName ?? "-"}`);
  }
}

main();
