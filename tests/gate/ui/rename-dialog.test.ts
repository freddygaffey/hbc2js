// tests/gate/ui/rename-dialog.test.ts — regression test for the rename
// dialog that never closed (`ui/e2e/smoke.spec.ts` "rename via the dialog
// shows up in Context (acceptedName) and Activity", failing on main before
// this fix). Root cause: `RenameDialog` treated "still waiting on
// GET /api/fn/{fn}/locals" and "that request errored" as the same thing
// (`locals.data === undefined`), so any fn whose locals 400 (no `--hbc`,
// spec 17's live-verb constraint — the common case in the e2e fixture,
// which boots the server without `--hbc`) stayed "pending" forever: submit
// always took the `pending` early-return and the dialog could never close.
//
// Pure file scanning, like actions-registry.test.ts: no ui/node_modules
// needed, and it pins the actual TanStack Query field (`isPending`, which
// settles to false on error) rather than re-deriving query semantics here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const dialog = readFileSync(join(repoRoot(), "ui", "src", "components", "RenameDialog.tsx"), "utf8");

test("RenameDialog's pending gate settles on locals.isPending, not locals.data === undefined", () => {
  assert.match(
    dialog,
    /const pending = ident !== undefined && locals\.isPending;/,
    "pending must settle once the locals query SETTLES (isPending goes false on error too), " +
      "not stay stuck forever when GET /api/fn/{fn}/locals 400s",
  );
  assert.doesNotMatch(
    dialog,
    /const pending = .*locals\.data === undefined/,
    "checking locals.data === undefined never turns false for an errored query — that was the bug",
  );
});

test("RenameDialog shows submit failures inline in the dialog, not only as a status toast", () => {
  assert.match(
    dialog,
    /setError\(err instanceof ToolError \? err\.reason/,
    "a failed submit must set the dialog's own error state from the server's reason",
  );
  assert.match(
    dialog,
    /\{error !== null && <ErrorNote>\{error\}<\/ErrorNote>\}/,
    "the error must render inside the dialog (ErrorNote), not just via setStatus's toast",
  );
});
