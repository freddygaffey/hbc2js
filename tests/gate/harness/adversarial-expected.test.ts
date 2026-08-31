// docs/CONSOLIDATION.md item 24 — adversarial fixtures' `expected.txt` must be
// what the fixture's source does as a *script* (sloppy / CommonJS semantics,
// which is what Metro feeds hermesc and what every `vNN.hbc` here encodes),
// never as a force-parsed ES module.
//
// Background: this repo's package.json has `"type": "module"`, so a bare
// `require('./source.js')` (the old README recipe) parsed every fixture as
// ESM. That silently changed the answer for two fixtures — 28's extracted
// method call saw `this === undefined` (always-strict ESM) instead of the
// sloppy-mode `globalThis` substitution, and 29's `function myVar(){}` +
// `var myVar` became an ESM-only SyntaxError — and left ESM loader frames in
// two more (36, 41). Node-as-script and all three Hermes VMs (v94/v96/v99)
// agree with each other on 28/29 and disagree with the ESM output, so the
// ESM output was simply the wrong reference (docs/BUGS.md 2026-08-31 row).
//
// This test re-derives every adversarial fixture's expectation with the
// README's step-3 recipe (`node --input-type=commonjs -e ...`) and checks the
// committed file against it: exact for programs that exit 0, prefix-only for
// programs that deliberately crash (their trailing Node stack trace carries
// the running Node's version string, which is noise, not semantics). It also
// rejects the ESM force-parse signature outright, so regenerating with the
// wrong recipe fails the gate instead of misleading the next reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const ADVERSARIAL = join(repoRoot(), "tests", "fixtures", "adversarial");
const PRINT_SHIM = "globalThis.print ??= (...a)=>console.log(...a.map(String)); ";

/** tests/fixtures/adversarial/README.md "How to add a fixture" step 3, verbatim
 *  as a spawn: explicit CommonJS so package.json's `"type": "module"` cannot
 *  reach the fixture. Returns stdout only (stderr is where Node's own crash
 *  report goes for a throwing program) and whether the program exited 0. */
export function deriveExpectedAsScript(sourceJs: string): { stdout: string; exitedZero: boolean } {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=commonjs", "-e", PRINT_SHIM + sourceJs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    return { stdout, exitedZero: true };
  } catch (e) {
    const err = e as { stdout?: string; status?: number | null };
    return { stdout: err.stdout ?? "", exitedZero: false };
  }
}

/** Frames only an ESM force-parse leaves behind (`loadESMFromCJS`,
 *  `compileSourceTextModule`, `file:///` module URLs). A script-mode run
 *  reports `[eval]` / `node:internal/vm` frames instead. */
const ESM_SIGNATURE = /node:internal\/modules\/esm|loadESMFromCJS|compileSourceTextModule|file:\/\/\//;

function fixtureDirs(): string[] {
  return readdirSync(ADVERSARIAL)
    .filter((d) => /^\d{2}-/.test(d))
    .map((d) => join(ADVERSARIAL, d))
    .filter((d) => existsSync(join(d, "source.js")) && existsSync(join(d, "expected.txt")))
    .sort();
}

test("adversarial expected.txt is derived in script mode, never as a force-parsed ES module (CONSOLIDATION 24)", () => {
  const dirs = fixtureDirs();
  assert.ok(dirs.length >= 42, `expected the full adversarial corpus, found ${dirs.length} fixtures with source.js + expected.txt`);
  for (const dir of dirs) {
    const name = dir.slice(ADVERSARIAL.length + 1);
    const expected = readFileSync(join(dir, "expected.txt"), "utf8");
    assert.ok(!ESM_SIGNATURE.test(expected), `${name}/expected.txt carries ES-module loader frames — regenerate it with the README's step-3 (\`node --input-type=commonjs\`) recipe`);
    const derived = deriveExpectedAsScript(readFileSync(join(dir, "source.js"), "utf8"));
    if (derived.exitedZero) {
      assert.equal(expected, derived.stdout, `${name}/expected.txt differs from the fixture run as a script`);
    } else {
      // Deliberately-crashing fixture: everything it printed before the throw
      // must lead the file; the Node crash report after it is version noise.
      assert.ok(expected.startsWith(derived.stdout), `${name}/expected.txt does not begin with the script-mode stdout (${JSON.stringify(derived.stdout.slice(0, 120))})`);
    }
  }
});

test("28/29: the ESM force-parse produced the wrong answer — script mode gives the sloppy-mode result the Hermes VMs also give", () => {
  // The two fixtures item 24 is about, pinned by value so a future regeneration
  // under the wrong recipe fails loudly rather than merely "differently".
  const r28 = deriveExpectedAsScript(readFileSync(join(ADVERSARIAL, "28-this-binding-extracted", "source.js"), "utf8"));
  assert.equal(r28.exitedZero, true);
  assert.match(r28.stdout, /^extracted: undefined-value$/m, "sloppy-mode bare call substitutes globalThis for `this`; the ESM run reported error:TypeError");
  const r29 = deriveExpectedAsScript(readFileSync(join(ADVERSARIAL, "29-var-hoisting-redeclaration", "source.js"), "utf8"));
  assert.equal(r29.exitedZero, true, "script mode: `function myVar(){}` + `var myVar` is legal; the ESM run was a SyntaxError");
  assert.equal(r29.stdout, "hoisting trace: function|function|string|string-value|is-string\n");
});
