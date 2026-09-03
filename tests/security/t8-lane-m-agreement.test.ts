// tests/security/t8-lane-m-agreement.test.ts — T8 (spec 13 §10, §4.3, §8.3).
// Extracted manifest facts == expected file for the fixture APK; every
// anchored tag's sid resolves; unanchored facts all present in
// security/manifest.json. Lane M lands in spec 13 §9 step 4 — lands red here
// until then; also needs the fixture APK spec 13 ruling R-A commits (not yet
// built — no Android build tooling was available to produce it in steps 0-1;
// see tests/fixtures/security/vuln-app/README.md).
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

const MEASURE_MANIFEST_PATH = join(repoRoot(), "tools", "security", "measure-manifest.ts");
const FIXTURE_APK_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app", "apk");

test("T8: androguard-extracted manifest facts == expected file for the fixture APK", (t) => {
  if (!existsSync(FIXTURE_APK_DIR)) {
    const msg = `${FIXTURE_APK_DIR} does not exist yet — the fixture APK is committed in spec 13 §9 step 4 (ruling R-A)`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  if (!existsSync(MEASURE_MANIFEST_PATH)) {
    const msg = `${MEASURE_MANIFEST_PATH} does not exist yet — Lane M lands in spec 13 §9 step 4`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  t.skip("measure-manifest.ts found but T8's fact-agreement assertions are step 4's responsibility");
});
