// tests/artifact/who-calls-by-name.test.ts — acceptance for the
// `who-calls-by-name` verb (docs/specs/17-mcp-harness.md §14): NAME-based
// caller recovery for the `require-once-into-a-slot` then `<slot>.export(...)`
// dispatch convention that plain `who-calls` returns `total:0` for. On the
// rn-template artifact, fn:180 (`sendAccessibilityEvent`, module 2) has NO
// resolved callers yet is dispatched by name from several other modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService, CAPS } from "../../src/artifact/service.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-who-by-name-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir, { hbc: RN_TEMPLATE });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

const EXPORT_FN = 180; // sendAccessibilityEvent, owned by module 2
const EXPORT_NAME = "sendAccessibilityEvent";

test("by-fn: a `who-calls total:0` fn gains ≥1 by-name candidate", () => {
  // Precondition: plain who-calls resolves NOTHING for this fn.
  assert.equal(svc.whoCalls(EXPORT_FN).total, 0);

  const r = svc.whoCallsByName({ fn: EXPORT_FN });
  // Step 1 proved the export name from bytecode.
  const named = r.names.find((n) => n.name === EXPORT_NAME);
  assert.ok(named !== undefined, "step 1 should recover the export name");
  assert.equal(named!.ambiguous, false);
  assert.ok(r.total >= 1, "should find at least one by-name caller");
  // Every row is a NAME match, never a resolved edge.
  for (const row of r.rows) {
    assert.equal(row.confidence, "by-name");
    assert.equal(row.role, "property-get");
  }
});

test("by-fn: the exporting module is excluded from candidates", () => {
  const r = svc.whoCallsByName({ fn: EXPORT_FN });
  assert.equal(r.excludedModule, 2);
  for (const row of r.rows) {
    assert.notEqual(svc.fn(row.fn).module, r.excludedModule, `row fn:${row.fn} must not be in the exporting module`);
  }
});

test("by-name: `--name` form finds the same candidates without step 1", () => {
  const byName = svc.whoCallsByName({ name: EXPORT_NAME });
  // No exporting module to exclude, so the by-name form sees ≥ the by-fn form.
  assert.ok(byName.total >= svc.whoCallsByName({ fn: EXPORT_FN }).total);
  assert.ok(byName.total >= 1);
  assert.equal(byName.excludedModule, null);
});

test("ambiguity: a common JS name is flagged, not dumped", () => {
  const r = svc.whoCallsByName({ name: "default" });
  assert.equal(r.names.length, 1);
  assert.equal(r.names[0]!.ambiguous, true);
  assert.match(r.names[0]!.why ?? "", /common JS name/);
  assert.equal(r.total, 0, "ambiguous names contribute no candidate rows");
});

test("ambiguity: a high-fan-out name is flagged by the fanout rule", () => {
  // `defineProperty` is read as a property in > 200 functions on rn-template.
  const r = svc.whoCallsByName({ name: "defineProperty" });
  assert.equal(r.names[0]!.ambiguous, true);
  assert.match(r.names[0]!.why ?? "", /read as a property/);
  assert.equal(r.total, 0);
});

test("caps: default result is bounded and honestly truncated; --all lifts it", () => {
  // `hasOwnProperty` fans out to > 50 but < 200 functions on rn-template.
  const bounded = svc.whoCallsByName({ name: "hasOwnProperty" });
  assert.ok(bounded.total > CAPS.whoCallsByName, "need a name that exceeds the cap");
  assert.equal(bounded.rows.length, CAPS.whoCallsByName);
  assert.equal(bounded.truncated, true);

  const all = svc.whoCallsByName({ name: "hasOwnProperty" }, { all: true });
  assert.equal(all.rows.length, all.total);
  assert.equal(all.truncated, false);
});

test("a name absent from the bundle is reported, not an error", () => {
  const r = svc.whoCallsByName({ name: "this_name_is_not_in_the_bundle_zzz" });
  assert.equal(r.total, 0);
  assert.equal(r.names[0]!.sid, null);
  assert.equal(r.names[0]!.ambiguous, false);
});
