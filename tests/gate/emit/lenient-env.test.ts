// review-M4-H2 — `--lenient-env`.
//
// Spec 03 §6.4's R3 rule refuses a module when an environment access cannot be
// resolved statically, and that stays the default. A 51 MB production bundle
// has thousands of such sites, so the whole file was unreadable through the CLI
// (the flag did not exist: `decompile()` hard-coded `strictEnv: true`). Lenient
// mode emits one LOUD `__hbc_unresolved_env(...)` marker per site instead — it
// throws when reached, so the output can never quietly read `undefined` there.
//
// No committed fixture has an unresolvable access (the gate reports 0), so the
// site is removed from a real fixture's env graph here to reach the path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { HELPERS } from "../../../src/runtime/helpers.ts";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";

const FIXTURE = "22-nested-closures-counters";

function analysed(): ModuleAnalysis {
  const path = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, "v94.hbc");
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  return analyseModule(module, { strictEnv: true });
}

/** The same analysis with one environment access made unresolvable. */
function withOneUnresolved(a: ModuleAnalysis): { analysis: ModuleAnalysis; dropped: string } {
  const keys = [...a.envGraph.resolvedAt.keys()];
  assert.ok(keys.length > 0, `${FIXTURE} has no resolved environment accesses any more`);
  const dropped = keys[0]!;
  const resolvedAt = new Map(a.envGraph.resolvedAt);
  resolvedAt.delete(dropped);
  return { analysis: { ...a, envGraph: { ...a.envGraph, resolvedAt }, cfg: (i) => a.cfg(i), decoded: (i) => a.decoded(i) }, dropped };
}

test("review-M4-H2: strict is still the default and still refuses", () => {
  const { analysis } = withOneUnresolved(analysed());
  assert.throws(
    () => emitModule(analysis, { moduleName: FIXTURE, provenanceComments: false }),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_ENV_UNRESOLVED,
    "the default must still be spec 03 §6.4's refusal",
  );
});

test("review-M4-H2: --lenient-env emits a loud marker and reports every site", () => {
  const { analysis } = withOneUnresolved(analysed());
  const result = emitModule(analysis, { moduleName: FIXTURE, provenanceComments: false, strictEnv: false });
  assert.match(result.code, /__hbc_unresolved_env\("(load|store)", \d+, \d+, \d+\)/, "no marker was emitted");
  const warned = result.diagnostics.filter((d) => d.code === "W_ENV_UNRESOLVED");
  assert.ok(warned.length >= 1, "the marker must be reported, not silent");
  assert.ok(result.helpersUsed.includes("__hbc_unresolved_env"), "the helper must be pulled into the prelude");
  // The prelude carries it, so `node --check`-clean output is still runnable up
  // to the marker.
  assert.match(result.code, /function __hbc_unresolved_env\(/);
});

test("review-M4-H2: the marker throws when reached, naming the site", () => {
  const source = HELPERS["__hbc_unresolved_env"]!.source;
  const fn = new Function(`${source}; return __hbc_unresolved_env;`)() as (k: string, f: number, o: number, s: number) => never;
  assert.throws(
    () => fn("load", 7, 42, 3),
    (e: unknown) => e instanceof Error && /unresolved environment load of slot 3/.test(e.message) && /fn#7 @42/.test(e.message) && /--lenient-env/.test(e.message),
    "the marker must fail loudly and say where it came from",
  );
});
