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

// -- follow-up: the UI now registers its own session (docs/BUGS.md "UI
// enqueues jobs without a session id") -------------------------------------
//
// The two tests above still pass unmodified: `enqueue()`'s body is built by
// spreading a helper (`createdByField()`), so the literal text "createdBy:"
// never appears on the `call("/jobs", …)` line, and nothing sends a
// hardcoded "ui" id. These tests pin the NEW half of the invariant: a real
// session id is what reaches the wire, sourced from a registration function,
// never a literal.
const appSrc = readFileSync(join(repoRoot(), "ui", "src", "App.tsx"), "utf8");

test("wire.ts exposes a session-registration function whose id feeds enqueue()", () => {
  assert.match(wireSrc, /export function initUiSession\(\)/, "expected an exported initUiSession() to register this tab's session");
  assert.match(wireSrc, /kind:\s*"human"/, "the UI registers itself as a kind: \"human\" session (spec 23 §3)");
  assert.match(
    wireSrc,
    /\.\.\.createdByField\(\)/,
    "enqueue() must spread the registered session id in, not inline a literal createdBy key",
  );
});

test("App mounts the session registration once, alongside the other one-time effects", () => {
  assert.match(appSrc, /initUiSession/, "App.tsx must call initUiSession() so a session actually gets registered");
});
