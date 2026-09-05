// tests/gate/native/dex-reader.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the read-only DEX
// parser: header + string/type/proto/field/method id tables + class_def +
// annotation directory; NO method-body decoding, per spec 27 §1.2). These
// tests are shipped skipped with the spec, before implementation, and run
// against the hermetic synthetic APK fixture of spec 27 §3
// (tools/native-fixture/gen.mjs -> tests/fixtures/native/, no JVM). They are
// property-based (round-trip / invariant), never a golden-output compare
// against a shared fixture (CLAUDE.md testing rules).
import { test } from "node:test";

const SKIP = { skip: "spec 27 L1 acceptance — unimplemented" } as const;

test("dex: parses the fixture header, string/type/method tables at the documented offsets", SKIP, () => {});

test("dex: recovers every class_def name and its superclass", SKIP, () => {});

test("dex: surfaces a method's @ReactMethod / @ReactModule annotation with its element values", SKIP, () => {});

test("dex: multi-dex (classes.dex + classes2.dex) yields the union with a stable `dex` column", SKIP, () => {});

test("dex: a truncated / non-DEX blob is refused with a typed error, never a partial fabricated table", SKIP, () => {});
