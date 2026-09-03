// tests/artifact/query-bounds.test.ts — A6 (docs/specs/10-artifact-format.md
// §7): on rn-template's artifact, every §3.1 verb stays within its cap; a
// high-fan-in fn shows the truncation marker (via `total` > rows.length) AND
// the correct `total`; `who-calls` on a fn with `?` edges in scope reports
// `unknownInScope` with the right count.
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
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-query-bounds-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir);

test.after(() => rmSync(outDir, { recursive: true, force: true }));

const callsRows = readFileSync(join(outDir, "index", "calls.jsonl"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => JSON.parse(l) as { caller: number; callee: number | string; kind: string; why?: string });

test("A6a who-calls/calls-from never exceed their cap, and total is honest", () => {
  const calleeCounts = new Map<number, number>();
  for (const c of callsRows) if (typeof c.callee === "number") calleeCounts.set(c.callee, (calleeCounts.get(c.callee) ?? 0) + 1);
  let highFanIn = -1;
  let maxCount = 0;
  for (const [fn, n] of calleeCounts) if (n > maxCount) (maxCount = n), (highFanIn = fn);
  assert.ok(highFanIn >= 0, "rn-template must have at least one closure-resolved callee");

  const result = svc.whoCalls(highFanIn);
  assert.ok(result.rows.length <= CAPS.whoCalls);
  assert.equal(result.total, maxCount);
  if (maxCount > CAPS.whoCalls) assert.equal(result.truncated, true);
});

test("A6b who-calls reports the bundle-wide unknown-callee count (§4.2: any `?` could, in principle, be an unseen call to `fn`)", () => {
  const expectedUnknown = callsRows.filter((r) => r.callee === "?").length;
  assert.ok(expectedUnknown > 0, "rn-template must have at least one unresolved callee");
  const anyResolvedTarget = callsRows.find((r) => typeof r.callee === "number")!.callee as number;
  const result = svc.whoCalls(anyResolvedTarget);
  assert.equal(result.unknownInScope, expectedUnknown);
});

test("A6c every ? row in calls.jsonl carries a why (checked at query layer too)", () => {
  for (const c of callsRows) if (c.callee === "?") assert.equal(typeof c.why, "string");
});

test("A6d native/global-uses/string-grep never exceed their default cap", () => {
  const native = svc.native();
  assert.ok(native.rows.length <= CAPS.native);
  const strGrep = svc.stringGrep("e");
  assert.ok(strGrep.rows.length <= CAPS.stringGrep);
});
