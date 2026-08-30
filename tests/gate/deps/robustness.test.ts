// docs/DECISIONS.md D17d: fingerprinting must be robust to debug info. A
// `hermesc -g` build inserts `AsyncBreakCheck` at every function entry and
// loop back-edge and allocates registers differently, so before
// docs/reviews/deps-v1.md not one function of the debug fixture hashed like
// its release twin (0 confirmed deps, 3.7% attributed). Release and debug
// builds of the same bundle must now confirm the same packages, detect the
// same react-native version, and attribute modules identically wherever
// both attribute at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { resolveDbLayers, loadSignatures } from "../../../src/deps/db.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { buildReport } from "../../../src/deps/report.ts";
import { normaliseFunctionForSignature, signatureInstructions } from "../../../src/deps/sig-normalise.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72");
const RELEASE = join(FIXTURE, "index.android.hbc");
const DEBUG = join(FIXTURE, "index.android.debug.hbc");

function run(path: string) {
  const { inventory } = buildInventory(readFileSync(path));
  const dbs = loadSignatures(resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false }));
  const matchReport = matchInventory(inventory, dbs);
  return { inventory, matchReport, report: buildReport(path, matchReport, []) };
}

test("-g: AsyncBreakCheck is elided from the signature view and its label carried to the next instruction", () => {
  const mod = parseHbc(readFileSync(DEBUG));
  let elided = 0;
  let carried = 0;
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    const kept = signatureInstructions(fn);
    const asyncChecks = fn.instructions.filter((x) => x.name === "AsyncBreakCheck").length;
    elided += asyncChecks;
    assert.equal(kept.length, fn.instructions.length - asyncChecks);
    assert.ok(kept.every((k) => k.insn.name !== "AsyncBreakCheck"));
    for (const insn of fn.instructions) {
      if (insn.name === "AsyncBreakCheck" && fn.labels.has(insn.offset)) carried++;
    }
    assert.doesNotMatch(normaliseFunctionForSignature(mod, fn), /AsyncBreakCheck/);
  }
  assert.ok(elided > 4000, `expected a -g build to carry thousands of AsyncBreakChecks, saw ${elided}`);
  assert.ok(carried > 0, "expected some loop back-edge labels to sit on an AsyncBreakCheck");
});

test("-g: release and debug builds confirm the same dependencies and react-native version", () => {
  const rel = run(RELEASE);
  const dbg = run(DEBUG);
  const names = (r: ReturnType<typeof run>) => r.report.confirmedDeps.map((d) => `${d.package}@${d.version}`).sort();
  assert.deepEqual(names(dbg), names(rel));
  assert.ok(names(rel).includes("react-native@0.72.17"));
  assert.equal(rel.report.reactNativeVersion, "0.72.17");
  assert.equal(dbg.report.reactNativeVersion, "0.72.17");
  assert.deepEqual(dbg.report.guessedDeps, rel.report.guessedDeps);
});

test("-g: module attribution agrees with the release build and covers >= 95% of it", () => {
  const rel = run(RELEASE);
  const dbg = run(DEBUG);
  const ownerOf = (r: ReturnType<typeof run>) => new Map(r.matchReport.moduleAttributions.map((m) => [m.localModuleId, m.owners[0] ?? null]));
  const relOwners = ownerOf(rel);
  const dbgOwners = ownerOf(dbg);
  let both = 0;
  let disagree = 0;
  let relOnly = 0;
  for (const [id, owner] of relOwners) {
    if (owner === null) continue;
    const d = dbgOwners.get(id) ?? null;
    if (d === null) relOnly++;
    else if (d === owner) both++;
    else disagree++;
  }
  assert.equal(disagree, 0, "a module attributed in both builds must get the same owner");
  assert.ok(both / (both + relOnly) >= 0.95, `debug build attributes ${both}/${both + relOnly} of the release build's modules`);
  assert.ok(dbg.matchReport.moduleAttributions.some((m) => m.ownerBasis === "fuzzy+strings"), "the fuzzy+strings fallback is what carries -g's differently-allocated factories");
});
