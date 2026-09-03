// T5 (spec 12 §8) — measure gate: tools/secrets/measure.ts --json on the
// seeded fixture + rn-template must meet §7.2's recall/FP/time targets.
// Not landed until impl step 4; guarded so a missing tool is a clean fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MEASURE_PATH = fileURLToPath(new URL("../../tools/secrets/measure.ts", import.meta.url));

test("T5 measure.ts meets §7.2 recall/FP/time targets (x3 CI slack on wall-time)", () => {
  assert.ok(existsSync(MEASURE_PATH), `${MEASURE_PATH} does not exist yet (spec 12 §9 step 4)`);
  if (!existsSync(MEASURE_PATH)) return;

  const res = spawnSync(process.execPath, [MEASURE_PATH, "--json"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as {
    recall: { tierA: number; overall: number };
    fpPer1k: { tuning: number };
    wallTimeMs: { cold: number; warm: number };
  };
  assert.equal(out.recall.tierA, 1, "100% tier-A recall required");
  assert.ok(out.recall.overall >= 0.95, "overall recall must be >= 95%");
  assert.ok(out.fpPer1k.tuning <= 5, "FP rate must be <= 5 per 1k on the tuning corpus");
  assert.ok(out.wallTimeMs.cold < 5000 * 3, "cold scan must be < 5s (x3 CI slack)");
  assert.ok(out.wallTimeMs.warm < 500 * 3, "warm re-scan must be < 0.5s (x3 CI slack)");
});
