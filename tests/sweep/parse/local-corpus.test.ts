// docs/specs/00-project-skeleton.md §2.1 (tests/sweep/local-corpus tier) / D16 C5 —
// proprietary APK-extracted bundles under the gitignored tests/fixtures/local-corpus/.
// Never commit the bundles themselves; only tests/fixtures/local-corpus/MANIFEST.json
// (hashes) is committed, and that file belongs to another agent (D16). This test
// reads whatever local-corpus/*.hbc files exist (if any) and reports INCONCLUSIVE
// (skip) rather than PASS when none are present, per D15.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseHbc } from "../../../src/index.ts";
import { repoRoot } from "../../support/paths.ts";
import { readBytes } from "../../support/bytes.ts";
import { requireSweep } from "../../support/tiers.ts";

// Deliberately does NOT honour HBC2JS_REQUIRE_ORACLES: unlike hermesc/hermes-dec
// (which CI provisions), the local corpus is proprietary APKs that are never
// committed and never available in CI (D16 C5) — treating its absence as a
// REQUIRE_ORACLES failure would make the sweep job fail forever in CI.
test("local-corpus (C5): every present .hbc parses without throwing", (t) => {
  if (!requireSweep(t)) return;
  const dir = join(repoRoot(), "tests", "fixtures", "local-corpus");
  if (!existsSync(dir)) {
    t.skip("tests/fixtures/local-corpus absent — INCONCLUSIVE, not a pass (D15/D16 C5)");
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".hbc"));
  if (files.length === 0) {
    t.skip("tests/fixtures/local-corpus has no .hbc files — INCONCLUSIVE, not a pass");
    return;
  }
  for (const f of files) {
    const bytes = readBytes(join(dir, f));
    const m = parseHbc(bytes);
    assert.ok(m.functions.length > 0, `${f}: zero functions`);
    console.log(`[local-corpus] ${f}: version=${m.header.version} layout=${m.layout.layoutClass} table=${m.layout.opcodeTable ?? "NONE"} functions=${m.functions.length}`);
  }
});
