// docs/DEVICE-TESTING.md — D16a: the real-device decompile -> repackage ->
// run proof. Sweep tier only (this scaffolds a full RN app, runs two Gradle
// release builds' worth of work already-built APK installs, and drives a
// physical/emulated Android device — minutes, not seconds) and INCONCLUSIVE
// (not a failure) whenever no device is attached, since almost no CI runner
// and few dev machines have one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";

function adbAvailable(): boolean {
  try {
    execFileSync("adb", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function deviceAttached(): boolean {
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
    return out.split("\n").slice(1).some((l) => /\tdevice$/.test(l.trim()));
  } catch {
    return false;
  }
}

test("D16a: device round-trip (decompile -> repackage -> run) matches the original build", async (t) => {
  if (!requireSweep(t)) return;
  if (!adbAvailable()) {
    t.skip("adb not on PATH — see docs/DEVICE-TESTING.md prerequisites");
    return;
  }
  if (!deviceAttached()) {
    t.skip("INCONCLUSIVE: no Android device attached (`adb devices` shows none) — this is expected on most machines/CI");
    return;
  }

  const script = `${repoRoot()}/tools/device-roundtrip.sh`;
  // Scaffolds its own throwaway RN app (no --app given), builds twice,
  // installs/launches/taps/compares twice, uninstalls at the end. Generous
  // timeout: a cold `npm install` + two Gradle release builds on real
  // hardware routinely takes several minutes.
  const result = spawnSync(script, [], {
    cwd: repoRoot(),
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });

  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);

  if (result.status === 3) {
    t.skip("INCONCLUSIVE: tools/device-roundtrip.sh reported no device attached");
    return;
  }
  assert.equal(result.status, 0, `device-roundtrip.sh exited ${result.status} (see stdout/stderr above) — 2 means the decompiled build DIVERGED from the original, which is a real bug, not flake`);
  assert.match(result.stdout, /logcat:\s+IDENTICAL/, "expected the report to say logcat: IDENTICAL");
});
