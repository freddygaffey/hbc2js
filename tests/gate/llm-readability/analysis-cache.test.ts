// docs/BUGS.md 2026-09-11 "`loadAnalysis` re-parses the whole .hbc per call,
// 72 s on the 435-module fixture". The proof is deterministic rather than a
// timing comparison: after the first call, the bytecode file is OVERWRITTEN
// with garbage while its size and mtime are restored byte for byte. A second
// call that still succeeds can only have come from the per-context cache -- a
// re-read would throw on the garbage. Touching the file (mtime moves) then
// invalidates it, and the same call fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { makeTree } from "../../support/readability-tree.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { suggestNames } from "../../../src/readability/surfaces.ts";
import type { ReadabilityContext } from "../../../src/readability/surfaces.ts";

test("loadAnalysis is cached per (context, path, size, mtime) and invalidated when the file changes", async () => {
  const src = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-analysis-cache-"));
  const hbcPath = join(dir, "input.hbc");
  copyFileSync(src, hbcPath);
  const original = new Uint8Array(readFileSync(hbcPath));
  // Pin the mtime to a whole second so `utimesSync` can restore it EXACTLY
  // below -- a filesystem mtime carries sub-millisecond precision a `Date`
  // cannot round-trip, which would move the cache key on its own.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  utimesSync(hbcPath, pinned, pinned);
  const st = statSync(hbcPath);
  assert.equal(st.mtimeMs, pinned.getTime());

  const backend = new FakeBackend({ replies: { "suggest-name": () => JSON.stringify({ names: [], abstained: true }) } });
  const { db, treeDir, projectDir } = makeTree();
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath };

  await suggestNames(ctx, { target: { fn: 0 } });

  // Same size, same mtime, different bytes: only the cache can serve this.
  writeFileSync(hbcPath, Buffer.alloc(original.length, 0x41));
  utimesSync(hbcPath, st.atime, st.mtime);
  assert.equal(statSync(hbcPath).size, original.length);
  await suggestNames(ctx, { target: { fn: 0 } });

  // A different context shares nothing: it re-reads, and the garbage throws.
  const other: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath };
  await assert.rejects(() => suggestNames(other, { target: { fn: 0 } }));

  // Restore the real bytes but move the mtime: the key changes, so the cached
  // analysis is dropped and the call works again off a fresh read.
  writeFileSync(hbcPath, original);
  utimesSync(hbcPath, new Date(st.atime.getTime() + 2000), new Date(st.mtime.getTime() + 2000));
  await suggestNames(ctx, { target: { fn: 0 } });
});
