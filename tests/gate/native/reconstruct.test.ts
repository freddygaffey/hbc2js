// tests/gate/native/reconstruct.test.ts
// docs/specs/27-native-side.md §L8 — rebuildable-project emit including the
// native side. The four tests spec 27 §L8 lists, each against an L6/L4/L3
// -private fixture already used by an earlier landing's own test (never a
// golden-output compare against a shared fixture -- CLAUDE.md testing
// rules): `env.apk` (§L6) for the `.env` pair, `party.apk` (§L4) for the
// dependency-dedup pair, `seams.apk` (§L3, reused by query-verbs.test.ts) for
// the first-party stub (it is the only fixture with an `@ReactMethod` that
// takes real parameters, `generateKey(String, Promise)`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildNativeTables, ingestNative, openApk } from "../../../src/native/ingest.ts";
import { reconstructNativeProject, renderEnvFile, renderModuleStub, renderResynthesizeMd, mergeNativeDependencies } from "../../../src/native/reconstruct.ts";
import { buildNativeChannel } from "../../../src/native/native-deps.ts";
import type { NativeModuleRow } from "../../../src/native/schema.ts";

const ENV_APK = join(repoRoot(), "tests", "fixtures", "native", "env.apk");
const PARTY_APK = join(repoRoot(), "tests", "fixtures", "native", "party.apk");
const SEAMS_APK = join(repoRoot(), "tests", "fixtures", "native", "seams.apk");

function tmpOutDir(): string {
  return mkdtempSync(join(tmpdir(), "hbc2js-reconstruct-"));
}

// -- test 1: a recovered .env value is emitted; an unresolved key is a
// commented TODO with evidence, not a value ---------------------------------
test("a recovered .env value is emitted; an unresolved key is a commented TODO with evidence, not a value", () => {
  const env = buildNativeTables(openApk(ENV_APK)).env;
  const text = renderEnvFile(env);
  assert.match(text, /^API_URL=https:\/\/api\.example\.test$/m, ".env must contain the recovered value as a real assignment line");
  const todoLine = text.split("\n").find((l) => l.includes("API_SECRET"));
  assert.ok(todoLine !== undefined, "API_SECRET must still appear (the key is a real fact)");
  assert.ok(todoLine!.startsWith("#"), "an unresolved key must be a commented line, never a value assignment");
  assert.match(todoLine!, /source: BuildConfig/, "the commented TODO must carry its evidence");
  assert.ok(!text.includes("API_SECRET=unresolved\n".replace("#", "")), "the literal string 'unresolved' must never be assigned as a value");
  assert.ok(!/^API_SECRET=/m.test(text), "API_SECRET must never appear as a plain assignment");
});

// -- test 2: a third-party native lib is a package.json dependency, not a
// stub -----------------------------------------------------------------------
test("a third-party native lib is a package.json dependency, not a stub", () => {
  const modules = buildNativeTables(openApk(PARTY_APK)).reactModules;
  const channel = buildNativeChannel(modules, new Set());
  const deps = mergeNativeDependencies({}, channel);
  assert.equal(deps["react-native-gesture-handler"], "*");
  // The third-party module must never get a native-todo stub.
  const outDir = tmpOutDir();
  try {
    ingestNative(openApk(PARTY_APK), outDir);
    const summary = reconstructNativeProject(outDir);
    assert.equal(summary.ran, true);
    assert.ok(!summary.firstPartyModules.includes("GestureHandler"), "a third-party module is never a native-todo stub");
    assert.ok(!existsSync(join(outDir, "native-todo", "GestureHandler")), "no native-todo dir for a third-party module");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// -- test 3: a first-party module is a native-todo stub with its method
// signatures and no fabricated body ------------------------------------------
test("a first-party module is a native-todo stub with its method signatures and no fabricated body", () => {
  const tables = buildNativeTables(openApk(SEAMS_APK));
  const crypto = tables.reactModules.find((m) => m.jsName === "Crypto");
  assert.ok(crypto !== undefined && crypto.firstParty === true, "Crypto must be labelled first-party in this fixture");
  const methodsByKey = new Map(tables.methods.map((m) => [m.key, m] as const));
  const stub = renderModuleStub(crypto as NativeModuleRow, methodsByKey);
  assert.match(stub, /public void generateKey\(java\.lang\.String arg0, com\.facebook\.react\.bridge\.Promise arg1\)/, "the recovered signature must be faithful (real types, real name)");
  assert.match(stub, /TODO RESYNTHESIZE/, "every method body must be flagged as a TODO");
  assert.doesNotMatch(stub, /return\s+["'0-9]/, "no fabricated return value");
  const md = renderResynthesizeMd(crypto as NativeModuleRow, methodsByKey);
  assert.match(md, /generateKey/, "RESYNTHESIZE.md must list the known exported surface");
  assert.match(md, /## Not known/);

  const outDir = tmpOutDir();
  try {
    ingestNative(openApk(SEAMS_APK), outDir);
    const summary = reconstructNativeProject(outDir);
    assert.ok(summary.firstPartyModules.includes("Crypto"));
    const stubPath = join(outDir, "native-todo", "Crypto", "Crypto.java");
    const mdPath = join(outDir, "native-todo", "Crypto", "RESYNTHESIZE.md");
    assert.ok(existsSync(stubPath) && existsSync(mdPath));
    assert.match(readFileSync(stubPath, "utf8"), /generateKey/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// -- test 4: the emitted project's package.json lists every merged native
// dep exactly once -----------------------------------------------------------
test("the emitted project's package.json lists every merged native dep exactly once", () => {
  const outDir = tmpOutDir();
  try {
    ingestNative(openApk(PARTY_APK), outDir);
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ name: "decompiled-app", version: "0.0.0", dependencies: { react: "18.2.0" } }, null, 2) + "\n");
    reconstructNativeProject(outDir);
    // Run it again -- idempotent, never a second entry / never duplicated.
    reconstructNativeProject(outDir);
    const pkgJson = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const names = Object.keys(pkgJson.dependencies).filter((n) => n === "react-native-gesture-handler");
    assert.deepEqual(names, ["react-native-gesture-handler"], "the native dep must appear exactly once, even after a second run");
    assert.equal(pkgJson.dependencies["react"], "18.2.0", "the JS-fingerprint channel's own version is never overwritten by the native channel");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// -- no-op path: a project directory with no native/ tables at all --------
test("a project directory with no native tables is a silent no-op", () => {
  const outDir = tmpOutDir();
  try {
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ name: "decompiled-app", version: "0.0.0" }) + "\n");
    const summary = reconstructNativeProject(outDir);
    assert.equal(summary.ran, false);
    assert.ok(!existsSync(join(outDir, ".env")));
    assert.ok(!existsSync(join(outDir, "native-todo")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
