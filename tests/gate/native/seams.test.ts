// tests/gate/native/seams.test.ts
// docs/specs/27-native-side.md L3 — the JS<->native linkage join
// (`native/seams.jsonl`). Property-based, cite-both-sides: every assertion
// resolves a row's evidence back into the two artifacts it cites
// (`index/string-uses.jsonl` + `index/strings.json` on the JS side,
// `native/react-modules.jsonl` on the native side), never a golden-output
// compare against a shared fixture (CLAUDE.md testing rules).
//
// Both halves are L3-private fixtures: the construct `66-native-module-seams`
// (compiled for every committed bytecode version by tests/fixtures/build.sh)
// and `tests/fixtures/native/seams.apk` (tools/native-fixture/gen.mjs) — the
// L1/L2-pinned `synthetic.apk` / `no-resources.apk` / `rn-modules.apk` bytes
// are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ingestNative, openApk } from "../../../src/native/ingest.ts";
import { buildNativeTables } from "../../../src/native/ingest.ts";
import { buildSeams } from "../../../src/native/seams.ts";
import { NATIVE_SCHEMA, parseNativeJsonl, type NativeModuleRow, type SeamRow } from "../../../src/native/schema.ts";
import type { StringUseRow } from "../../../src/artifact/schema.ts";

const APK = join(repoRoot(), "tests", "fixtures", "native", "seams.apk");
const FIXTURE = "66-native-module-seams";
const VERSIONS = [84, 94, 96, 98, 99] as const;

interface Joined {
  readonly version: number;
  readonly dir: string;
  readonly seams: readonly SeamRow[];
  readonly modules: readonly NativeModuleRow[];
  readonly stringUses: readonly StringUseRow[];
  readonly strings: ReadonlyMap<number, string>;
}

function jsonl(dir: string, file: string): unknown[] {
  const lines = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.length > 0);
  return lines.slice(1).map((l) => JSON.parse(l) as unknown);
}

/** Decompile the construct fixture into a real artifact, ingest the APK into
 *  the same directory, and read back what landed on disk. */
function joinAt(version: number): Joined | null {
  const hbc = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${version}.hbc`);
  if (!existsSync(hbc)) return null;
  const bytes = readFileSync(hbc);
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seams-"));
  writeArtifact({ bytes, splitResult: splitProject(bytes, {}), outDir: dir, passes: {}, strictEnv: false, form: "flat" });
  const result = ingestNative(openApk(APK), dir);
  assert.ok(result.seams !== null, "a directory with both halves must get a seams table");
  const parsed = parseNativeJsonl(readFileSync(join(dir, "native", "seams.jsonl"), "utf8"));
  assert.equal((parsed.header as unknown as { schema: string }).schema, NATIVE_SCHEMA);
  assert.equal(parsed.header.kind, "seams");
  const strings = new Map<number, string>();
  for (const e of (JSON.parse(readFileSync(join(dir, "index", "strings.json"), "utf8")) as { entries: { sid: number; v?: string }[] }).entries) {
    if (typeof e.v === "string") strings.set(e.sid, e.v);
  }
  return {
    version,
    dir,
    seams: parsed.rows as SeamRow[],
    modules: jsonl(dir, "native/react-modules.jsonl") as NativeModuleRow[],
    stringUses: jsonl(dir, "index/string-uses.jsonl") as StringUseRow[],
    strings,
  };
}

const joins = VERSIONS.map(joinAt).filter((j): j is Joined => j !== null);
assert.ok(joins.length > 0, `no compiled ${FIXTURE} fixture found — run tests/fixtures/build.sh`);

test.after(() => {
  for (const j of joins) rmSync(j.dir, { recursive: true, force: true });
});

const find = (j: Joined, key: string): SeamRow | undefined => j.seams.find((s) => s.key === key);

test("a linked seam's jsEvidence ids resolve in string-uses.jsonl AND its native.module resolves in react-modules.jsonl", () => {
  for (const j of joins) {
    const linked = j.seams.filter((s) => s.status === "linked");
    assert.ok(linked.length > 0, `v${j.version}: the fixture pair must produce linked seams`);
    const moduleKeys = new Map(j.modules.map((m) => [m.key, m]));
    for (const row of linked) {
      // native side: the cited module (and method, when present) exist.
      assert.ok(row.native !== null, `${row.key} is linked but cites no native side`);
      const mod = moduleKeys.get(row.native!.module);
      assert.ok(mod !== undefined, `v${j.version}: ${row.key} cites ${row.native!.module}, absent from react-modules.jsonl`);
      assert.equal(mod!.jsName, row.jsName, "exact-name join: the linked module's jsName is the seam's jsName");
      if (row.native!.method !== null) {
        const m = mod!.methods.find((x) => x.nativeMethod === row.native!.method);
        assert.ok(m !== undefined, `${row.key} cites a method that is not an exported method of ${mod!.key}`);
        assert.equal(m!.jsName, row.jsMethod);
      }
      // JS side: every cited sid is a real string-use row, in a cited
      // function, whose text is the name the row claims.
      assert.ok(row.jsEvidence !== null, `${row.key} is linked but cites no JS side`);
      assert.ok(row.jsEvidence!.callSites.length > 0, `${row.key} cites no function`);
      const fns = new Set(row.jsEvidence!.callSites.map((c) => Number(c.slice("fn:".length))));
      const claimed = new Set([row.jsName, row.jsMethod].filter((x): x is string => x !== null));
      for (const id of row.jsEvidence!.stringUses) {
        const sid = Number(id.slice("sid:".length));
        assert.ok(
          j.stringUses.some((u) => u.sid === sid && fns.has(u.fn)),
          `v${j.version}: ${row.key} cites ${id}, which has no string-uses.jsonl row in ${[...fns].join(",")}`,
        );
        assert.ok(claimed.has(j.strings.get(sid) ?? ""), `${row.key} cites ${id} = ${JSON.stringify(j.strings.get(sid))}, which is neither its jsName nor its jsMethod`);
      }
      assert.equal(row.jsEvidence!.resolved, "string-only");
      // spec 27 §L4: `ingestNative`/`writeSeams` label `firstParty` from the
      // linked module's own label; every class in seams.apk sits under its
      // own manifest package com.example.seam, so a linked row is
      // first-party. L4's own fixture (`party.apk`) exercises the other
      // outcomes; this file stays L3's own join assertions.
      assert.equal(row.firstParty, true, "every module in seams.apk sits under its own manifest package com.example.seam");
    }
  }
});

test("a JS NativeModules.X with no native impl is js-only with native:null, never dropped and never guessed", () => {
  for (const j of joins) {
    const row = find(j, "seam:Missing");
    assert.ok(row !== undefined, `v${j.version}: NativeModules.Missing must not be dropped just because the APK has no impl`);
    assert.equal(row!.status, "js-only");
    assert.equal(row!.native, null, "a js-only seam names no native module — an unresolved boundary, never a guess");
    assert.equal(row!.jsName, "Missing");
    assert.equal(row!.channel, "NativeModules");
    assert.ok(row!.jsEvidence !== null && row!.jsEvidence.callSites.length > 0);
    // The APK really has no such module: the row is a fact about both sides.
    assert.ok(!j.modules.some((m) => m.jsName === "Missing"));
    // ... and nothing invented a native module for it anywhere in the table.
    assert.ok(!j.seams.some((s) => s.jsName === "Missing" && s.native !== null));
  }
});

test("a native module never referenced from JS is native-only", () => {
  for (const j of joins) {
    const row = find(j, "seam:Analytics");
    assert.ok(row !== undefined, `v${j.version}: a native module with no JS reference must still be reported`);
    assert.equal(row!.status, "native-only");
    assert.equal(row!.jsEvidence, null, "a native-only seam cites no JS evidence — symmetric with native:null");
    assert.equal(row!.channel, null);
    assert.equal(row!.native?.module, j.modules.find((m) => m.jsName === "Analytics")!.key);
    // Nothing in the bundle uses that name in a boundary role.
    assert.ok(!j.seams.some((s) => s.jsName === "Analytics" && s.jsEvidence !== null));
  }
});

test("matching is exact-name — a Crypto JS ref never links to a CryptoStore native module", () => {
  for (const j of joins) {
    const store = j.modules.find((m) => m.jsName === "CryptoStore");
    assert.ok(store !== undefined, "the fixture APK must ship the substring-shaped CryptoStore module");
    for (const row of j.seams) {
      if (row.native?.module !== store!.key) continue;
      assert.equal(row.status, "native-only", "CryptoStore is only ever reachable as a native-only seam");
      assert.equal(row.jsName, "CryptoStore");
    }
    // No seam links a JS name to a native module of a different name.
    for (const row of j.seams.filter((s) => s.status === "linked")) {
      const mod = j.modules.find((m) => m.key === row.native!.module)!;
      assert.equal(mod.jsName, row.jsName);
    }
    // The prefix relationship exists in the data, and is still not a link.
    assert.ok(store!.jsName!.startsWith("Crypto") && store!.jsName !== "Crypto");
  }
});

test("the CryptoModule-shaped fixture produces exactly one linked seam citing both halves", () => {
  for (const j of joins) {
    const crypto = j.seams.filter((s) => s.jsName === "Crypto" && s.status === "linked");
    assert.equal(crypto.length, 1, `v${j.version}: expected exactly one linked Crypto seam, got ${JSON.stringify(crypto.map((c) => c.key))}`);
    const row = crypto[0]!;
    assert.equal(row.key, "seam:Crypto.generateKey");
    assert.equal(row.jsMethod, "generateKey");
    const mod = j.modules.find((m) => m.key === row.native!.module)!;
    assert.equal(mod.nameEvidence, "annotation");
    assert.equal(mod.kind, "bridge");
    assert.ok(mod.methods.some((m) => m.jsName === "generateKey" && m.nativeMethod === row.native!.method));
    // Both halves' strings are cited, and both resolve.
    const texts = row.jsEvidence!.stringUses.map((id) => j.strings.get(Number(id.slice("sid:".length))));
    assert.deepEqual([...texts].sort(), ["Crypto", "generateKey"]);
  }
});

test("the other two JS boundary shapes link by their own channel: TurboModuleRegistry.get(\"X\") and requireNativeComponent(\"Y\")", () => {
  for (const j of joins) {
    const x = find(j, "seam:X");
    assert.ok(x !== undefined && x.status === "linked", `v${j.version}: TurboModuleRegistry.get("X") must link to the NativeXSpec module`);
    assert.equal(x!.channel, "TurboModuleRegistry");
    assert.equal(j.modules.find((m) => m.key === x!.native!.module)!.kind, "turbo");
    const y = find(j, "seam:Y");
    assert.ok(y !== undefined && y.status === "linked", `v${j.version}: requireNativeComponent("Y") must link to the view manager`);
    assert.equal(y!.channel, "requireNativeComponent");
    assert.equal(j.modules.find((m) => m.key === y!.native!.module)!.kind, "viewmanager");
    // A view manager exports no methods at L2, so the seam claims none.
    assert.equal(y!.jsMethod, null);
    assert.equal(y!.native!.method, null);
  }
});

test("no JS artifact -> no seams table at all, and the join is pure (same inputs, same rows)", () => {
  // Native-only directory: nothing to join against, so nothing is written —
  // an absent table says "not joinable", which is the truth.
  const bare = mkdtempSync(join(tmpdir(), "hbc2js-seams-bare-"));
  try {
    const result = ingestNative(openApk(APK), bare);
    assert.equal(result.seams, null);
    assert.ok(!existsSync(join(bare, "native", "seams.jsonl")));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  // Purity: buildSeams over the same rows twice is identical, and every row
  // is either linked / js-only / native-only with the documented nullness.
  const modules = buildNativeTables(openApk(APK)).reactModules;
  const j = joins[0]!;
  const js = {
    strings: j.strings,
    stringUses: j.stringUses,
    globals: jsonl(j.dir, "index/globals.jsonl") as never,
    functions: jsonl(j.dir, "index/functions.jsonl") as never,
  };
  assert.deepEqual(buildSeams(js, modules), buildSeams(js, modules));
  assert.deepEqual(buildSeams(null, modules).map((r) => r.status), modules.map(() => "native-only"));
  for (const row of j.seams) {
    assert.equal(row.native === null, row.status === "js-only");
    assert.equal(row.jsEvidence === null, row.status === "native-only");
    assert.ok(row.key.startsWith("seam:"));
  }
  const keys = j.seams.map((r) => r.key);
  assert.deepEqual(keys, [...keys].sort(), "seams.jsonl is sorted by its primary key");
  assert.equal(new Set(keys).size, keys.length, "seam keys are unique");
});

test("both real anchor shapes link the same seam: inline chain (a) and module-top capture via functions.jsonl parent (b)", () => {
  for (const j of joins) {
    const row = find(j, "seam:Crypto.generateKey");
    assert.ok(row !== undefined && row.status === "linked", `v${j.version}: seam:Crypto.generateKey must be linked`);
    const fns = row!.jsEvidence!.callSites.map((c) => Number(c.slice("fn:".length)));
    assert.ok(fns.length >= 2, `v${j.version}: expected evidence from both boundary shapes, got fns=${JSON.stringify(fns)}`);

    const functions = jsonl(j.dir, "index/functions.jsonl") as { fn: number; parent: number | null }[];
    const parentOf = new Map(functions.map((f) => [f.fn, f.parent]));
    const nativeModulesSid = [...j.strings.entries()].find(([, v]) => v === "NativeModules")?.[0];
    assert.ok(nativeModulesSid !== undefined, `v${j.version}: "NativeModules" must be a materialised string`);
    const hasAnchorHere = (fn: number): boolean => j.stringUses.some((u) => u.fn === fn && u.sid === nativeModulesSid && (u.role === "property-get" || u.role === "global-name"));

    // Shape (a) inline: at least one cited function carries the "NativeModules"
    // anchor string-use itself (same function as the Crypto/generateKey uses).
    const inlineFns = fns.filter(hasAnchorHere);
    assert.ok(inlineFns.length >= 1, `v${j.version}: expected an inline-shape function citing "NativeModules" directly`);

    // Shape (b) module-top capture: at least one cited function carries NO
    // "NativeModules" string-use of its own, yet a lexical ancestor does —
    // provable only by walking functions.jsonl's parent chain.
    const captureFns = fns.filter((fn) => !hasAnchorHere(fn));
    assert.ok(captureFns.length >= 1, `v${j.version}: expected a module-top-capture function citing no "NativeModules" use of its own`);
    for (const fn of captureFns) {
      let cur: number | null = parentOf.get(fn) ?? null;
      let foundAncestorAnchor = false;
      while (cur !== null) {
        if (hasAnchorHere(cur)) {
          foundAncestorAnchor = true;
          break;
        }
        cur = parentOf.get(cur) ?? null;
      }
      assert.ok(foundAncestorAnchor, `v${j.version}: fn:${fn} has no direct "NativeModules" use, but no ancestor carries it either`);
    }
  }
});
