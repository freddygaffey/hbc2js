// tests/ui-core/log-delta.test.ts — spec 26 L1 (iii)'s acceptance tests for
// `ui/src/state/log-delta.ts`'s `applyLogDelta`, the pure mapping from one
// log entry to the TanStack Query key targets it invalidates.
//
// `ui/src/` is a separate package from the root tree (same reasoning as
// `tests/gate/ui/activity.test.ts`'s header comment) — dynamic `import()` by
// file URL, not a relative TS import, so this runs under the root `npm test`
// with no `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../support/paths.ts";

const logDeltaFile = join(repoRoot(), "ui", "src", "state", "log-delta.ts");

async function loadApplyLogDelta(): Promise<(entry: { readonly op: string; readonly detail: string | null }) => readonly string[]> {
  const mod = (await import(pathToFileURL(logDeltaFile).href)) as { applyLogDelta: (entry: { readonly op: string; readonly detail: string | null }) => readonly string[] };
  return mod.applyLogDelta;
}

test("applyLogDelta: a set_name on fn:N invalidates that fn's keys and nothing else", async () => {
  const applyLogDelta = await loadApplyLogDelta();
  const targets = applyLogDelta({ op: "annotate", detail: JSON.stringify({ kind: "name", target: "fn:12" }) });
  assert.deepEqual([...targets].sort(), ["context:12", "fn:12", "who-calls-by-name:12"]);
  // Nothing about fn 13, and no global keys, leaked in.
  assert.ok(!targets.some((t) => t.endsWith(":13")));
  assert.ok(!targets.includes("findings"));
});

test("applyLogDelta: an unknown target invalidates nothing rather than everything", async () => {
  const applyLogDelta = await loadApplyLogDelta();
  // A target prefix this module does not recognise.
  assert.deepEqual(applyLogDelta({ op: "annotate", detail: JSON.stringify({ kind: "tag", target: "widget:5" }) }), []);
  // No detail at all (e.g. an `op:'init'` row, or a row minted before this
  // landing's `appendLog` change started embedding `target`).
  assert.deepEqual(applyLogDelta({ op: "init", detail: JSON.stringify({ bundleSha256: "abc" }) }), []);
  assert.deepEqual(applyLogDelta({ op: "annotate", detail: null }), []);
  // Malformed JSON must not throw.
  assert.deepEqual(applyLogDelta({ op: "annotate", detail: "{not json" }), []);
});

test("applyLogDelta: a finding write invalidates the findings key", async () => {
  const applyLogDelta = await loadApplyLogDelta();
  const targets = applyLogDelta({ op: "annotate", detail: JSON.stringify({ kind: "finding", target: "fn:7" }) });
  assert.ok(targets.includes("findings"), `expected "findings" in ${JSON.stringify(targets)}`);
  const statusTargets = applyLogDelta({ op: "annotate", detail: JSON.stringify({ kind: "status", target: "fn:7" }) });
  assert.ok(statusTargets.includes("findings"), `expected "findings" in ${JSON.stringify(statusTargets)}`);
});
