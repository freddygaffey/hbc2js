// tests/gate/native/ingest-tables.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the ingest orchestrator
// that writes native/{classes,methods,strings,resources,assets}.jsonl +
// native/manifest.json under <artifact>/native/, and the tools/artifact/
// check-native.ts re-walker, spec 27 §L1 + §4). Shipped skipped with the spec,
// before implementation; property-based, against the hermetic synthetic APK
// fixture (spec 27 §3). Truth rules (spec 27 §4): recomputable + re-walk agrees;
// assets are inventory-only (no bytes copied into any table); an absent input
// yields zero rows + a note, never an error and never a fabricated row.
import { test } from "node:test";

const SKIP = { skip: "spec 27 L1 acceptance — unimplemented" } as const;

test("ingest: writes native/*.jsonl with schema headers and primary-key sort", SKIP, () => {});

test("ingest: check-native re-walk agrees with the builder row-for-row on the fixture", SKIP, () => {});

test("ingest: assets.jsonl is inventory-only — no asset bytes appear in any table", SKIP, () => {});

test("ingest: absent resources.arsc yields zero resource rows + a note, never an error and never a fabricated row", SKIP, () => {});
