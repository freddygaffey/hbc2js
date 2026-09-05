// tests/gate/native/dex-reader.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the read-only DEX
// parser: header + string/type/proto/field/method id tables + class_def +
// annotation directory; NO method-body decoding, per spec 27 §1.2). These
// tests are shipped skipped with the spec, before implementation, and run
// against the hermetic synthetic APK fixture of spec 27 §3
// (tools/native-fixture/gen.mjs -> tests/fixtures/native/, no JVM). They are
// property-based (round-trip / invariant), never a golden-output compare
// against a shared fixture (CLAUDE.md testing rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hbc2jsError } from "../../../src/errors.ts";
import { parseDex } from "../../../src/native/dex.ts";
import { buildNativeTables, openApk } from "../../../src/native/ingest.ts";

const APK = "tests/fixtures/native/synthetic.apk";

function dexBytes(name: string): Uint8Array {
  const bytes = openApk(APK).read(name);
  assert.ok(bytes !== null, `${name} is missing from ${APK}`);
  return bytes;
}

test("dex: parses the fixture header, string/type/method tables at the documented offsets", () => {
  const bytes = dexBytes("classes.dex");
  const image = parseDex(bytes);
  // Header facts are read, and reported, exactly as the bytes hold them.
  assert.equal(image.header.version, "035");
  assert.equal(image.header.endianTag, 0x12345678);
  assert.equal(image.header.headerSize, 0x70);
  assert.equal(image.header.fileSize, bytes.length);
  assert.equal(image.header.signature.length, 40);
  // The id tables start where the header says, and every table is fully read.
  assert.equal(image.header.stringIds.off, 0x70);
  assert.equal(image.strings.length, image.header.stringIds.size);
  assert.equal(image.types.length, image.header.typeIds.size);
  assert.equal(image.protos.length, image.header.protoIds.size);
  assert.equal(image.fields.length, image.header.fieldIds.size);
  assert.equal(image.methods.length, image.header.methodIds.size);
  assert.equal(image.classes.length, image.header.classDefs.size);
  // Cross-table invariants: every type descriptor is one of the strings, and
  // every method's class/name are drawn from the tables above it.
  const strings = new Set(image.strings);
  for (const t of image.types) assert.ok(strings.has(t), `type ${t} is not in the string pool`);
  for (const m of image.methods) {
    assert.ok(image.types.includes(m.class), `method class ${m.class} is not a type id`);
    assert.ok(strings.has(m.name), `method name ${m.name} is not in the string pool`);
    assert.match(m.proto.descriptor, /^\(.*\)[A-Z[].*$/);
  }
  // string_ids is sorted by MUTF-8 byte order (the format's own invariant).
  for (let i = 1; i < image.strings.length; i++) {
    const a = Buffer.from(image.strings[i - 1]!, "utf8");
    const b = Buffer.from(image.strings[i]!, "utf8");
    assert.ok(Buffer.compare(a, b) < 0, `string pool is not sorted at ${i}`);
  }
});

test("dex: recovers every class_def name and its superclass", () => {
  const image = parseDex(dexBytes("classes.dex"));
  assert.equal(image.classes.length, image.header.classDefs.size);
  const byName = new Map(image.classes.map((c) => [c.name, c]));
  for (const c of image.classes) assert.match(c.name, /^L[\w/$]+;$/);
  const crypto = byName.get("Lcom/example/app/CryptoModule;");
  assert.ok(crypto !== undefined, "the authored CryptoModule class_def is missing");
  assert.equal(crypto.super, "Lcom/facebook/react/bridge/ReactContextBaseJavaModule;");
  assert.equal(crypto.sourceFile, "CryptoModule.java");
  assert.ok(crypto.access.includes("public"));
  const buildConfig = byName.get("Lcom/example/app/BuildConfig;");
  assert.ok(buildConfig !== undefined, "the authored BuildConfig class_def is missing");
  assert.equal(buildConfig.super, "Ljava/lang/Object;");
  // static_final constants live in the data section, not in a method body, so
  // the minimal parser reads them (spec 27 §1.2's "static final" case).
  const domain = buildConfig.staticFields.find((f) => f.name === "APIGEE_DOMAIN");
  assert.ok(domain !== undefined);
  assert.equal(domain.value, "https://api.example.test");
  // The second dex's spec class carries its TurboModule marker interface.
  const spec = parseDex(dexBytes("classes2.dex")).classes.find((c) => c.name === "Lcom/example/app/NativeCryptoSpec;");
  assert.ok(spec !== undefined);
  assert.deepEqual([...spec.interfaces], ["Lcom/facebook/react/turbomodule/core/interfaces/TurboModule;"]);
});

test("dex: surfaces a method's @ReactMethod / @ReactModule annotation with its element values", () => {
  const image = parseDex(dexBytes("classes.dex"));
  const crypto = image.classes.find((c) => c.name === "Lcom/example/app/CryptoModule;");
  assert.ok(crypto !== undefined);
  const classAnn = crypto.annotations.find((a) => a.type === "Lcom/facebook/react/module/annotations/ReactModule;");
  assert.ok(classAnn !== undefined, "@ReactModule class annotation was not surfaced");
  assert.equal(classAnn.elements["name"], "Crypto");
  const generateKey = crypto.methods.find((m) => m.name === "generateKey");
  assert.ok(generateKey !== undefined);
  assert.equal(generateKey.proto, "(Ljava/lang/String;Lcom/facebook/react/bridge/Promise;)V");
  const methodAnn = generateKey.annotations.find((a) => a.type === "Lcom/facebook/react/bridge/ReactMethod;");
  assert.ok(methodAnn !== undefined, "@ReactMethod method annotation was not surfaced");
  assert.equal(methodAnn.elements["isBlockingSynchronousMethod"], false);
  // A method with no annotation gets an empty list, never an invented one.
  const helper = crypto.methods.find((m) => m.name === "internalHelper");
  assert.ok(helper !== undefined);
  assert.deepEqual([...helper.annotations], []);
});

test("dex: multi-dex (classes.dex + classes2.dex) yields the union with a stable `dex` column", () => {
  const first = parseDex(dexBytes("classes.dex"));
  const second = parseDex(dexBytes("classes2.dex"));
  const tables = buildNativeTables(openApk(APK));
  assert.equal(tables.dexFiles.length, 2);
  assert.deepEqual([...tables.dexFiles], ["classes.dex", "classes2.dex"]);
  // Union, with no row lost and none duplicated.
  assert.equal(tables.classes.length, first.classes.length + second.classes.length);
  assert.equal(tables.strings.length, first.strings.length + second.strings.length);
  const dexOf = new Map(tables.classes.map((c) => [c.name, c.dex]));
  for (const c of first.classes) assert.equal(dexOf.get(c.name), 0, `${c.name} should be attributed to dex 0`);
  for (const c of second.classes) assert.equal(dexOf.get(c.name), 1, `${c.name} should be attributed to dex 1`);
  // Every method row is attributed to the same dex as its class, and string
  // indices restart per dex (they are that dex's own pool indices).
  const classDex = new Map(tables.classes.map((c) => [c.key, c.dex]));
  for (const m of tables.methods) assert.equal(m.dex, classDex.get(m.class));
  for (const d of [0, 1]) {
    const idx = tables.strings.filter((s) => s.dex === d).map((s) => s.i);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
    assert.equal(idx[0], 0);
  }
});

test("dex: a truncated / non-DEX blob is refused with a typed error, never a partial fabricated table", () => {
  const bytes = dexBytes("classes.dex");
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["short-of-a-header", bytes.subarray(0, 40)],
    ["truncated-mid-table", bytes.subarray(0, 200)],
    ["not-a-dex", new TextEncoder().encode("this is definitely not a dex file, not even close")],
  ];
  for (const [label, blob] of cases) {
    let thrown: unknown;
    try {
      parseDex(blob);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof Hbc2jsError, `${label}: expected a typed Hbc2jsError, got ${String(thrown)}`);
    assert.match(thrown.code, /^E_(TRUNCATED|BAD_MAGIC|SECTION_OVERRUN|SECTION_MISMATCH|BAD_STRING_ID|TABLE_ASSERT|UNSUPPORTED_VERSION)$/);
  }
  // The valid prefix of a truncated dex must NOT come back as a partial image.
  assert.throws(() => parseDex(bytes.subarray(0, bytes.length - 8)), Hbc2jsError);
});
