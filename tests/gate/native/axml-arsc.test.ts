// tests/gate/native/axml-arsc.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the minimal binary-XML
// (AndroidManifest.xml) and resources.arsc chunk decoders, spec 27 §1.2 / the
// native/manifest.json + native/resources.jsonl contracts). Shipped skipped
// with the spec, before implementation; property-based, against the hermetic
// synthetic APK fixture (spec 27 §3). Truth rule: an absent android:exported
// attribute is `null` (unknown), never a guessed boolean; a resource that is a
// reference stays a reference, never flattened by guessing.
import { test } from "node:test";

const SKIP = { skip: "spec 27 L1 acceptance — unimplemented" } as const;

test("axml: decodes AndroidManifest package + permissions + exported components from real binary-XML bytes (superset of apk.ts's heuristic)", SKIP, () => {});

test("axml: a manifest with no `android:exported` attribute yields `exported:null`, never a guessed boolean", SKIP, () => {});

test("arsc: resolves an `@string/x` reference to its default-config value", SKIP, () => {});

test("arsc: a value that is itself a resource reference stays `{ref:...}`, not flattened", SKIP, () => {});
