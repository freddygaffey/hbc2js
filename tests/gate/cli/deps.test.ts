// docs/DECISIONS.md D17a/D17b — `hbc2js deps` CLI, exercised via child
// process (matches tests/gate/cli/cli.test.ts's own convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { ingestNative, openApk } from "../../../src/native/ingest.ts";
import { requireHermesc, runHermesc } from "../../support/hermesc.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const PARTY_APK = join(repoRoot(), "tests", "fixtures", "native", "party.apk");
const SYNTHETIC_APK = join(repoRoot(), "tests", "fixtures", "native", "synthetic.apk");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("deps --help prints usage and exits 0", () => {
  const r = runCli(["deps", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("deps with no input exits 2", () => {
  const r = runCli(["deps"]);
  assert.equal(r.status, 2);
});

test("deps --offline on rn-template-0.72: text report finds react + react-native, not lodash", () => {
  const r = runCli(["deps", RN_TEMPLATE, "--offline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /confirmed dependencies/);
  assert.match(r.stdout, /react-native@0\.72\.17/);
  assert.match(r.stdout, /react@18\.2\.0/);
  // lodash may appear only under "guessed / unconfirmed", never as a
  // confirmed dependency line.
  const confirmedSection = r.stdout.split("== guessed")[0]!;
  assert.doesNotMatch(confirmedSection, /lodash/);
});

test("deps --offline on rn-template-0.72: a hints section is printed (additive, empty for this fixture)", () => {
  const r = runCli(["deps", RN_TEMPLATE, "--offline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /== hints \(\d+.*not counted in attribution\) ==/);
});

test("deps --offline --json on rn-template-0.72: machine-readable report shape", () => {
  const r = runCli(["deps", RN_TEMPLATE, "--offline", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout) as {
    hbcVersion: number;
    confirmedDeps: { package: string; version: string }[];
    hintedDeps: { package: string }[];
    reactNativeVersion: string | null;
    attribution: { percentAttributed: number };
  };
  assert.equal(report.hbcVersion, 94);
  assert.equal(report.reactNativeVersion, "0.72.17");
  const names = report.confirmedDeps.map((d) => d.package);
  assert.ok(names.includes("react-native"));
  assert.ok(names.includes("react"));
  assert.ok(!names.includes("lodash"));
  assert.ok(report.attribution.percentAttributed > 90);
  assert.ok(Array.isArray(report.hintedDeps), "hintedDeps is present in --json output even when empty");
});

test("deps --offline --out <dir> writes package.json with confirmed dependencies", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-cli-out-"));
  try {
    const r = runCli(["deps", RN_TEMPLATE, "--offline", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    const pkgJson = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkgJson.dependencies["react-native"], "0.72.17");
    assert.equal(pkgJson.dependencies["react"], "18.2.0");
    assert.ok(!("lodash" in pkgJson.dependencies));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// docs/specs/27-native-side.md §L8: the CLI hook fires once a project
// directory holds native tables (here, from a separate `ingestNative` call —
// the same two-step "split, then ingest the APK's native side into the same
// dir" the L3/L5 tests use — `deps --out` never re-parses an APK's DEX
// itself). Named `native-reconstruct` in spec 27 §L8's own text as
// `tests/appgen/native-reconstruct.test.ts`; landed here instead, beside the
// rest of this file's `deps --out` CLI tests (spec 27 L8 Landed note).
test("deps --offline --out <dir>, once native tables are ingested into <dir>, reconstructs the native side (spec 27 L8)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-cli-native-out-"));
  try {
    let r = runCli(["deps", RN_TEMPLATE, "--offline", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    ingestNative(openApk(PARTY_APK), outDir);
    r = runCli(["deps", RN_TEMPLATE, "--offline", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /native reconstruction/);
    const pkgJson = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkgJson.dependencies["react-native-gesture-handler"], "*", "the native-only dep must be merged in");
    assert.equal(pkgJson.dependencies["react-native"], "0.72.17", "the JS-fingerprint channel's own version is untouched");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// spec 27 §L9 (closing the L8 gap): a single `deps <apk> --out <dir>` call,
// on an `.apk` that carries BOTH a real Hermes bundle and a native side,
// must yield native/*.jsonl + .env + package.json deps + native-todo/ in
// one run -- no separate `ingestNative` call, unlike the L8 test above.
// `synthetic.apk` (docs/specs/27-native-side.md §3 "primary" fixture) is
// the committed native fixture; this test builds a fresh, uncommitted APK
// in a temp dir by adding a `hermesc`-compiled `assets/index.android.bundle`
// beside its existing entries (`zip`/`unzip`, the same external tools
// `src/deps/apk.ts` already shells out to at runtime) -- hermetic, and the
// committed fixture itself is never modified.
test("deps <apk> --out <dir>, single run: native/*.jsonl + .env + package.json deps + native-todo/ (spec 27 L9)", (t) => {
  const hermesc = requireHermesc(t, 94);
  if (hermesc === null) return;
  const srcDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-cli-e2e-apk-src-"));
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-cli-e2e-apk-out-"));
  try {
    spawnSync("unzip", ["-o", SYNTHETIC_APK, "-d", srcDir], { encoding: "utf8" });
    writeFileSync(join(srcDir, "probe.js"), "var hello = 'native-l9';\n");
    const emit = runHermesc(hermesc, ["-emit-binary", "-out=assets/index.android.bundle", "probe.js"], srcDir);
    assert.equal(emit.status, 0, emit.stderr);
    const combinedApk = join(srcDir, "combined.apk");
    const zipResult = spawnSync("zip", ["-r", "-X", "combined.apk", "AndroidManifest.xml", "classes.dex", "classes2.dex", "resources.arsc", "assets"], { cwd: srcDir, encoding: "utf8" });
    assert.equal(zipResult.status, 0, zipResult.stderr);

    const r = runCli(["deps", combinedApk, "--offline", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    // docs/BUGS.md "deps --out native-ingest path (stale dist)" row: a
    // successful native ingestion must ALWAYS say so on stderr, so a build
    // missing the L9 wiring entirely (silence) is visibly different from a
    // build that ran it. No exact-count assertion (fixture-specific numbers
    // are not the point) -- just that the positive line is there.
    assert.match(r.stderr, /hbc2js deps --out: native ingestion — \d+ modules, \d+ tables written/, r.stderr);

    const nativeFiles = readdirSync(join(outDir, "native"));
    for (const f of ["classes.jsonl", "methods.jsonl", "react-modules.jsonl", "env.jsonl", "manifest.json"]) {
      assert.ok(nativeFiles.includes(f), `expected native/${f} from a single deps --out run`);
    }
    const envText = readFileSync(join(outDir, ".env"), "utf8");
    assert.match(envText, /^APIGEE_DOMAIN=https:\/\/api\.example\.test$/m, ".env must carry the recovered env value");
    const pkgJson = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkgJson.dependencies["react-native-keychain"], "*", "the third-party native dep must be merged in");
    assert.ok(existsSync(join(outDir, "native-todo", "Crypto", "Crypto.java")), "the first-party module must get a native-todo stub");
    assert.ok(existsSync(join(outDir, "native-todo", "Crypto", "RESYNTHESIZE.md")));
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("deps on a nonexistent file exits non-zero with a JSON error under --json", () => {
  const r = runCli(["deps", "/nonexistent/does-not-exist.hbc", "--offline", "--json"]);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout) as { error: string };
  assert.ok(parsed.error.length > 0);
});

test("deps --json output larger than the 64 KB pipe buffer arrives whole when piped (docs/BUGS.md 2026-08-30)", () => {
  // With no DB every module is unattributed and listed: ~100 KB of JSON. `process.exit()` after an
  // async pipe write used to cut it at 64 KB; the CLI sets exitCode instead.
  const r = runCli(["deps", join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"), "--offline", "--no-shared-db", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) > 65536, `expected > 64 KB of output, got ${Buffer.byteLength(r.stdout)}`);
  const report = JSON.parse(r.stdout) as { confirmedDeps: { package: string }[] };
  assert.equal(report.confirmedDeps.length, 0);
});
