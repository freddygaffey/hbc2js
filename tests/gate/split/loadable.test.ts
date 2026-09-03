// docs/e2e/STAGE3-FEASIBILITY.md, Gap A + Gap B: prove the `--split` tree
// itself boots under bare Node, not just that it structurally parses
// (tests/gate/split/split.test.ts). This spawns a child process (isolation:
// the harness patches `Module._load` and mutates `globalThis`, neither of
// which should leak into the rest of the gate) that requires the split
// tree's `index.js` under a minimal native-surface recording stub — the
// same shape as the feasibility doc's spike (§f) — and asserts:
//
//  - no ReferenceError for any `__hbc_*` helper (Gap B: the prelude must be
//    installed as globals before any factory runs);
//  - no ReferenceError for any `module_N` factory reference (Gap A: `__d`
//    registration must complete for every module before `__r(entry)` runs);
//  - at least 76 modules' factories actually execute (the feasibility doc's
//    §f spike floor on this exact fixture, rn-template-0.72's
//    index.android.hbc, 435 modules) — not just "index.js required without
//    throwing", which the pre-loader `module.exports = factory` shape also
//    satisfied trivially without running anything.
//
// Not a full boot (no react-native-web, no jsdom — docs/e2e/STAGE3-FEASIBILITY.md
// §c/§e's next milestones): the harness's stub is deliberately the
// `Symbol.toPrimitive`/`apply`/`construct`-returning-proxy shape from §f,
// nothing more, so the same first failure (module 154, `window` is not
// defined — a browser-environment check with no jsdom present) is expected
// and is not a regression to chase here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

// The spike's floor (docs/e2e/STAGE3-FEASIBILITY.md §f, 3rd iteration): 76 of
// 435 modules ran before the first non-helper, non-module-graph failure
// (module 154's `window` ReferenceError, a real browser-environment check —
// not something this gap-A/gap-B loader is responsible for). Pinned as a
// floor, not an exact count: an unrelated readability/emit change should
// never silently *lower* it.
const MIN_MODULES_RUN = 76;

// A deliberately small stub: every native touchpoint the spike found
// (nativeModuleProxy, __fbBatchedBridge, nativeFabricUIManager,
// nativePerformanceNow, performance) becomes a recording Proxy whose
// function calls/constructions also return proxies (chained access must not
// throw partway through) and whose Symbol.toPrimitive/valueOf/toString/
// Symbol.iterator are stubbed (so arithmetic/coercion/iteration on a
// stubbed value doesn't throw either) -- copied inline per the task's "copy
// the small shim, don't depend on scratch" instruction.
const HARNESS_SCRIPT = `
"use strict";
const path = require("path");

function makeRecordingProxy(label) {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "valueOf") return () => 0;
      if (prop === "toString") return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      return makeRecordingProxy(label + "." + String(prop));
    },
    apply() {
      return makeRecordingProxy(label + "()");
    },
    construct() {
      return makeRecordingProxy("new " + label);
    },
  };
  return new Proxy(function () {}, handler);
}

global.nativeModuleProxy = makeRecordingProxy("nativeModuleProxy");
global.__fbBatchedBridge = makeRecordingProxy("__fbBatchedBridge");
global.nativeFabricUIManager = makeRecordingProxy("nativeFabricUIManager");
global.nativePerformanceNow = () => 0;
global.performance = makeRecordingProxy("performance");

const ran = new Set();
global.__hbc_split_onModuleRun = (id) => ran.add(id);

let threw = null;
try {
  require(path.join(process.argv[2], "index.js"));
} catch (e) {
  threw = e && e.stack ? e.stack.split("\\n").slice(0, 6).join(" | ") : String(e);
}
process.stdout.write(JSON.stringify({ ran: ran.size, threw }));
`;

test("--split tree boots under bare Node: __d/__r loader + helper prelude, no missing-symbol errors", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const result = splitProject(bytes, { moduleName: "index.android.hbc" });
  assert.notEqual(result.entryModuleId, null, result.diagnostics.join("; "));

  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-split-loadable-"));
  const harnessPath = join(outDir, "__harness.cjs");
  try {
    for (const [name, content] of result.files) writeFileSync(join(outDir, name), content);
    writeFileSync(harnessPath, HARNESS_SCRIPT);

    const r = spawnSync(process.execPath, [harnessPath, outDir], { encoding: "utf8", shell: false });
    assert.equal(r.status, 0, `harness process failed: ${r.stderr}`);

    const out = JSON.parse(r.stdout) as { readonly ran: number; readonly threw: string | null };

    // Gap A/B regression guard: neither an undeclared __hbc_* helper nor an
    // undeclared module_N factory reference should ever throw a
    // ReferenceError -- both would have been "is not defined" before this
    // change (module.exports = factory meant nothing ever ran, and no
    // helper was ever installed anywhere in the split tree).
    if (out.threw !== null) {
      assert.doesNotMatch(out.threw, /ReferenceError: __hbc_/, `an __hbc_* helper is missing from the split tree's prelude: ${out.threw}`);
      assert.doesNotMatch(out.threw, /ReferenceError: (factory|__d|__r) is not defined/, `the __d/__r loader itself is broken: ${out.threw}`);
      assert.doesNotMatch(out.threw, /is not registered/, `a module was reached before its __d() registration ran: ${out.threw}`);
    }

    assert.ok(out.ran >= MIN_MODULES_RUN, `expected at least ${MIN_MODULES_RUN} modules to run, got ${out.ran}${out.threw !== null ? ` (stopped at: ${out.threw})` : ""}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
