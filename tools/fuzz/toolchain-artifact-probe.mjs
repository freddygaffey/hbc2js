#!/usr/bin/env node
// Diagnostic-only, one-shot probe for the 2026-09-04 toolchain-artifact
// investigation (docs/reports/2026-09-04-toolchain-artifact-investigation.md).
// NOT wired into any gate/CI path. For each sampled reports/fuzz/finds/*.js:
//   1. compile with tools/hermesc/v<N>/hermesc (current harness "mismatched"
//      pairing) and run under tools/hermes-vm/v<N>/bin/hermes
//   2. compile with tools/hermes-vm/v<N>/bin/hermesc (matched pairing, where
//      that binary exists) and run under the same VM
// then print both raw traces so a human/agent can tell whether the
// divergence signature is toolchain drift or survives under a matched
// compiler (candidate genuine decompiler divergence).
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { findHermesVm, runHermesAsync } from "../../src/harness/hermes-vm.ts";
import { repoRoot } from "../../src/util/paths.ts";

const findsDir = join(repoRoot(), "reports", "fuzz", "finds");
const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: node tools/fuzz/toolchain-artifact-probe.mjs v99-seed777007.js ...");
  process.exit(1);
}

for (const name of names) {
  const version = Number(name.match(/^v(\d+)-/)[1]);
  const program = readFileSync(join(findsDir, name), "utf8");
  console.log(`\n=== ${name} (v${version}) ===`);

  const mismatched = findHermesc(version);
  if (mismatched === null) {
    console.log("  no tools/hermesc compiler for this version — skipped");
    continue;
  }
  const matchedPath = join(repoRoot(), "tools", "hermes-vm", `v${version}`, "bin", "hermesc");
  const vm = findHermesVm(version);
  if (vm === null) {
    console.log("  no hermes-vm for this version — skipped (VM mismatch not possible)");
    continue;
  }
  const sameBinary = vm.path === mismatched.path.replace(/hermesc$/, "hermes");
  console.log(`  compile(mismatched)=${mismatched.path}  vm=${vm.path}  sameBinaryTree=${sameBinary}`);

  const compMis = compileWithHermesc(mismatched, program, "fuzz.js");
  if (!compMis.ok) {
    console.log(`  mismatched compile FAILED: ${compMis.error.slice(0, 200)}`);
    continue;
  }
  const runMis = await runHermesAsync(vm.path, writeTmp(compMis.bytes), { timeout: 5000, bytecode: true });
  console.log(`  [mismatched compile -> matched-vm-binary run] ok=${runMis.ok} timedOut=${runMis.timedOut}`);
  console.log(`    ${JSON.stringify(runMis.lines.slice(0, 6))}`);

  if (!existsSync(matchedPath)) {
    console.log(`  no matched hermesc at ${matchedPath} — cannot disambiguate for this version`);
    continue;
  }
  const matched = { version, path: matchedPath };
  const compMat = compileWithHermesc(matched, program, "fuzz.js");
  if (!compMat.ok) {
    console.log(`  matched compile FAILED: ${compMat.error.slice(0, 200)}`);
    continue;
  }
  const runMat = await runHermesAsync(vm.path, writeTmp(compMat.bytes), { timeout: 5000, bytecode: true });
  console.log(`  [matched compile -> matched-vm-binary run]     ok=${runMat.ok} timedOut=${runMat.timedOut}`);
  console.log(`    ${JSON.stringify(runMat.lines.slice(0, 6))}`);

  const same = JSON.stringify(runMis.lines) === JSON.stringify(runMat.lines) && runMis.ok === runMat.ok;
  console.log(`  RESULT: mismatched-vs-matched VM output ${same ? "IDENTICAL (not a toolchain artifact by this test)" : "DIFFERS (toolchain-sensitive)"}`);
}

function writeTmp(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-probe-"));
  const p = join(dir, "probe.hbc");
  writeFileSync(p, bytes);
  return p;
}
