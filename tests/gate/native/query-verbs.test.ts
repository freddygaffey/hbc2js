// tests/gate/native/query-verbs.test.ts — docs/specs/27-native-side.md §L5:
// read verbs over the native/ tables (L1-L4) on `ArtifactService` + the CLI.
// Reuses the L3 fixture pair (`66-native-module-seams` JS half +
// `tests/fixtures/native/seams.apk` native half) that `tests/gate/native/
// seams.test.ts` already builds a joined artifact from — no new fixture, no
// exact-output compare against a shared fixture (CLAUDE.md testing rules):
// every assertion here is a structural/count/regex check on THIS test's own
// artifact directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { ingestNative, openApk } from "../../../src/native/ingest.ts";
import { Hbc2jsError } from "../../../src/errors.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const APK = join(repoRoot(), "tests", "fixtures", "native", "seams.apk");
const HBC = join(repoRoot(), "tests", "fixtures", "constructs", "66-native-module-seams", "v96.hbc");

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-native-query-"));
const bytes = readFileSync(HBC);
writeArtifact({ bytes, splitResult: splitProject(bytes, {}), outDir, passes: {}, strictEnv: false, form: "flat" });
ingestNative(openApk(APK), outDir);
const svc = new ArtifactService(outDir, { hbc: HBC });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("nativeModules() returns every react-modules.jsonl row, sorted, capped, with a total", () => {
  const result = svc.nativeModules();
  assert.ok(result.total > 0);
  assert.ok(result.rows.length <= result.total);
  const keys = result.rows.map((r) => r.key);
  assert.deepEqual(keys, [...keys].sort());
});

test("nativeModule(X) returns the module, its methods, and its seams in one call", () => {
  const found = svc.nativeModule("Crypto");
  assert.ok(found !== null);
  assert.equal(found!.module.jsName, "Crypto");
  assert.ok(found!.module.methods.some((m) => m.jsName === "generateKey"));
  assert.ok(found!.seams.some((s) => s.key === "seam:Crypto.generateKey" && s.status === "linked"));
});

test("nativeModule() on an unknown name is null, never guessed", () => {
  assert.equal(svc.nativeModule("NoSuchModuleAtAll"), null);
});

test("seams({status:'js-only'}) returns only unlinked JS refs", () => {
  const result = svc.seams({ status: "js-only" });
  assert.ok(result.rows.length > 0);
  for (const r of result.rows) {
    assert.equal(r.status, "js-only");
    assert.equal(r.native, null);
  }
});

test("seams({status:'native-only'}) returns only native-only rows", () => {
  const result = svc.seams({ status: "native-only" });
  assert.ok(result.rows.length > 0);
  for (const r of result.rows) assert.equal(r.status, "native-only");
});

test("nativeManifest() returns the AXML-derived package/permissions block", () => {
  const m = svc.nativeManifest();
  assert.ok(m !== null);
  assert.equal(typeof m!.permissions.length, "number");
});

test("nativeResources() filters by key regex", () => {
  const all = svc.nativeResources(".*");
  const none = svc.nativeResources("^nope-nothing-matches-this-key$");
  assert.equal(none.rows.length, 0);
  assert.ok(all.total >= none.total);
});

test("nativeImplFor(fn) is empty for a fn that participates in no seam", () => {
  // fn 0 is always the global/module wrapper in a flat split artifact and
  // never itself the call site that touches a NativeModules/TurboModule
  // string (those calls live inside named functions in the fixture).
  const seamFns = new Set<number>();
  for (const s of svc.seams({ all: true }).rows) {
    for (const c of s.jsEvidence?.callSites ?? []) seamFns.add(Number(c.slice("fn:".length)));
  }
  const nonSeamFn = svc.listFns().map((f) => f.fn).find((fn) => !seamFns.has(fn));
  assert.ok(nonSeamFn !== undefined, "the fixture must have at least one fn outside every seam");
  assert.deepEqual(svc.nativeImplFor(nonSeamFn!), []);
});

test("nativeImplFor(fn) reports the linked module for a seam call site", () => {
  const cryptoSeam = svc.seams({ status: "linked" }).rows.find((s) => s.key === "seam:Crypto.generateKey");
  assert.ok(cryptoSeam !== undefined);
  const fn = Number(cryptoSeam!.jsEvidence!.callSites[0]!.slice("fn:".length));
  const impls = svc.nativeImplFor(fn);
  assert.ok(impls.some((i) => i.seam.key === "seam:Crypto.generateKey" && i.module?.jsName === "Crypto"));
});

test("a directory with no native/ ingested answers empty/null, never throws", () => {
  const bareBytes = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "66-native-module-seams", "v96.hbc"));
  const bareDir = mkdtempSync(join(tmpdir(), "hbc2js-native-query-bare-"));
  try {
    writeArtifact({ bytes: bareBytes, splitResult: splitProject(bareBytes, {}), outDir: bareDir, passes: {}, strictEnv: false, form: "flat" });
    const bareSvc = new ArtifactService(bareDir);
    assert.deepEqual(bareSvc.nativeModules().rows, []);
    assert.equal(bareSvc.nativeModule("Crypto"), null);
    assert.deepEqual(bareSvc.seams().rows, []);
    assert.equal(bareSvc.nativeManifest(), null);
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }
});

test("the query surface refuses on a stale artifact (E_STALE_INDEX), same as every other verb", () => {
  const manifestPath = join(outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { index: { builtFor: { bundleSha256: string } } };
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-native-query-stale-"));
  try {
    writeArtifact({ bytes, splitResult: splitProject(bytes, {}), outDir: staleDir, passes: {}, strictEnv: false, form: "flat" });
    const staleManifestPath = join(staleDir, "manifest.json");
    const staleManifest = JSON.parse(readFileSync(staleManifestPath, "utf8")) as typeof manifest;
    staleManifest.index.builtFor.bundleSha256 = "0".repeat(64);
    writeFileSync(staleManifestPath, JSON.stringify(staleManifest, null, 2) + "\n");
    assert.throws(
      () => new ArtifactService(staleDir),
      (e: unknown) => e instanceof Hbc2jsError && e.code === "E_STALE_INDEX",
    );
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }
});

// -- CLI -------------------------------------------------------------------

test("CLI: `query native modules` lists modules with a total line", () => {
  const out = execFileSync("node", [CLI, "query", "native", "modules", "--artifact", outDir], { encoding: "utf8" });
  assert.match(out, /jsName:Crypto/);
  assert.match(out, /^total:\d+$/m);
});

test("CLI: `query native module Crypto` shows the module, its method and its seam", () => {
  const out = execFileSync("node", [CLI, "query", "native", "module", "Crypto", "--artifact", outDir], { encoding: "utf8" });
  assert.match(out, /jsName:Crypto/);
  assert.match(out, /method generateKey ->/);
  assert.match(out, /seam seam:Crypto\.generateKey status:linked/);
});

test("CLI: `query native seams --status js-only` prints only js-only rows", () => {
  const out = execFileSync("node", [CLI, "query", "native", "seams", "--status", "js-only", "--artifact", outDir], { encoding: "utf8" });
  const lines = out.split("\n").filter((l) => l.startsWith("seam:"));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, /status:js-only/);
});

test("CLI: `query native manifest` and `query native resources --key` still work, and legacy `query native --fn` is untouched", () => {
  const manifestOut = execFileSync("node", [CLI, "query", "native", "manifest", "--artifact", outDir], { encoding: "utf8" });
  assert.match(manifestOut, /permissions:\d+/);
  const resourcesOut = execFileSync("node", [CLI, "query", "native", "resources", "--key", ".*", "--artifact", outDir], { encoding: "utf8" });
  assert.match(resourcesOut, /^total:\d+$/m);
  // Legacy JS-side host-access surface (spec 10 §3.1), unrelated verb space.
  const legacyOut = execFileSync("node", [CLI, "query", "native", "--artifact", outDir, "--json"], { encoding: "utf8" });
  const legacy = JSON.parse(legacyOut) as { total: number };
  assert.equal(typeof legacy.total, "number");
});
