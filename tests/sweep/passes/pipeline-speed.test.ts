// docs/PUSHBACK.md P-1 — sweep-tier companion to
// tests/gate/passes/pipeline-speed.test.ts: every rn-template variant that is
// present (optimised/noopt × release/debug), decompiled with every pass on,
// must finish inside 30 s (scaled) and within 12x of the passes-off time.
// Before the fix the optimised bundle alone did not finish inside 180 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireSweep, timeScale } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";

test("P-1 sweep: every rn-template variant decompiles with all passes on inside 30 s and 12x of passes-off", (t) => {
  if (!requireSweep(t)) return;
  const dir = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72");
  const names = ["index.android.hbc", "index.android.debug.hbc", "index.android.noopt.hbc", "index.android.noopt.debug.hbc"];
  let checked = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      statSync(path);
    } catch {
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    // CPU time, not wall-clock: `node --test` runs files in parallel
    // processes, and only CPU time is immune to being starved by them (see
    // the gate test's `cpuMs`).
    const time = (passesOn: boolean): number => {
      const t0 = process.cpuUsage();
      const r = decompile(bytes, { passes: passesOn ? {} : { none: true }, analysis: { strictEnv: false }, resolveV98Ambiguity: true, moduleName: name });
      assert.ok(r.code.length > 0);
      const d = process.cpuUsage(t0);
      return (d.user + d.system) / 1000;
    };
    const off1 = time(false);
    const on = time(true);
    const off = Math.min(off1, time(false));
    const budget = 30_000 * timeScale();
    assert.ok(on < budget, `${name}: passes-on decompile took ${on.toFixed(0)} ms (budget ${budget} ms)`);
    assert.ok(on / off <= 12, `${name}: passes-on/passes-off ratio ${(on / off).toFixed(1)} (on ${on.toFixed(0)} ms, off ${off.toFixed(0)} ms) exceeds 12x`);
    checked++;
  }
  assert.ok(checked > 0, "no rn-template bundle was available");
});
