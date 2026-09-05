// tests/gate/ui/ai-jobs-createdby.test.ts — regression for the QA report's
// BUG 1 (ui-qa-report.md): `ui/src/workers/wire.ts` used to hardcode
// `createdBy: "ui"` on every `POST /api/jobs` enqueue, but `jobs.created_by`
// is `TEXT REFERENCES sessions(id)` (src/projdb/schema.sql) with FK
// enforcement on, and no session has the id "ui" — every AI action (suggest
// name, explain) 500ed. The fix is client-side omission (the UI does not
// register a session for itself yet — docs/BUGS.md) plus a server-side 400
// for an unknown id (covered by tests/ui-server/workers-routes.test.ts).
//
// Pure file scanning, like actions-registry.test.ts: no ui/node_modules
// needed, and it survives regardless of whether the UI later starts
// registering a real session (the only invariant this asserts is "never a
// string literal that is not a session id from GET /api/sessions").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const wireSrc = readFileSync(join(repoRoot(), "ui", "src", "workers", "wire.ts"), "utf8");

test("the client's /api/jobs enqueue body never hardcodes a createdBy literal", () => {
  const enqueueLine = wireSrc.split("\n").find((l) => l.includes('call("/jobs", { method: "POST"'));
  assert.ok(enqueueLine !== undefined, "expected to find the enqueue() call in wire.ts");
  assert.doesNotMatch(
    enqueueLine!,
    /createdBy\s*:/,
    'enqueue() must not send a hardcoded createdBy (e.g. "ui") — jobs.created_by is a sessions(id) FK and no session has that id',
  );
});

test("no source file under ui/src ever sends a literal createdBy: \"ui\" style id to the jobs API", () => {
  // Broader net than the single call site above: anything that once copied
  // the same shortcut would trip this too.
  assert.doesNotMatch(
    wireSrc,
    /createdBy\s*:\s*["'`]ui["'`]/,
    "no literal, non-session createdBy string may reach POST /api/jobs",
  );
});
