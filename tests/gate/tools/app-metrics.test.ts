// Regression test for tools/app-metrics.mjs (QUEUE "CI app decompile
// metrics" item): the script decompiles a whole real RN bundle end to end
// with today's `decompile()`/`splitProject()`/`runDeps()` APIs, so a future
// API change that silently breaks the tool (rather than the decompiler) is
// caught here instead of only in CI's markdown output. Not a metrics-value
// assertion (docs/CONSOLIDATION.md §B item 7) — only structural shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureApp } from "../../../tools/app-metrics.mjs";

const BUNDLE = new URL("../../fixtures/bundles/rn-template-0.72/index.android.hbc", import.meta.url).pathname;

test("app-metrics: measureApp decompiles the rn-template bundle whole-file with --lenient-env", async () => {
  const m = await measureApp(BUNDLE, { split: false });
  assert.equal(m.decompile.ok, true, "whole-file decompile should not throw");
  assert.ok("totalFunctions" in m, "an ok decompile reports the full metric shape"); // narrows m for TS below
  if (!("totalFunctions" in m)) return;
  assert.ok(m.totalFunctions > 0, "should report a nonzero function count");
  assert.ok(m.outputBytes > 0, "should emit nonempty JS");
  assert.equal(m.nodeCheck.ok, true, "emitted JS must be syntactically valid");
  assert.ok(m.readability.registers.per1kLines >= 0);
  assert.ok(m.readability.reflectApply.per1kLines >= 0);
  assert.ok(m.readability.anonFnNames.per1kLines >= 0);
  assert.ok(m.readability.hbcHelperCalls.per1kLines >= 0);
});

test("app-metrics: --split mode also reports split + classification summary", async () => {
  const m = await measureApp(BUNDLE, { split: true });
  assert.equal(m.decompile.ok, true);
  if (!("totalFunctions" in m)) return;
  assert.ok(m.split !== undefined, "split result should be attached");
  if (m.split !== undefined && m.split.ok) {
    assert.ok(m.split.moduleCount > 0);
  }
});
