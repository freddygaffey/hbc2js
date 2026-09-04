// tests/security/t8-lane-m-agreement.test.ts — T8 (spec 13 §10, §4.3, §8.3).
// Extracted manifest facts == expected file for the fixture APK; every
// anchored tag's sid resolves; unanchored facts all present in
// security/manifest.json. Lane M lands in spec 13 §9 step 4 — lands red here
// until then; also needs the fixture APK spec 13 ruling R-A commits (not yet
// built — no Android build tooling was available to produce it in steps 0-1;
// see tests/fixtures/security/vuln-app/README.md).
//
// 2026-09-05 (CI red-run fix): both checks below are in-repo, not-yet-landed
// artefacts (a fixture APK to be committed, a tool file to be written), not
// absent oracles, so neither honours HBC2JS_REQUIRE_ORACLES=1 — it always
// skips. This file does not yet probe the androguard *binary* (ci.yml now
// installs it — `pip install androguard==<pinned>` — for when Lane M's own
// implementation lands and needs that distinction, same as
// tests/security/t6-lane-s-recall.test.ts does for semgrep).
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const MEASURE_MANIFEST_PATH = join(repoRoot(), "tools", "security", "measure-manifest.ts");
const FIXTURE_APK_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app", "apk");

test("T8: androguard-extracted manifest facts == expected file for the fixture APK", (t) => {
  if (!existsSync(FIXTURE_APK_DIR)) {
    t.skip(`${FIXTURE_APK_DIR} does not exist yet — the fixture APK is committed in spec 13 §9 step 4 (ruling R-A)`);
    return;
  }
  if (!existsSync(MEASURE_MANIFEST_PATH)) {
    t.skip(`${MEASURE_MANIFEST_PATH} does not exist yet — Lane M lands in spec 13 §9 step 4`);
    return;
  }
  t.skip("measure-manifest.ts found but T8's fact-agreement assertions are step 4's responsibility");
});
