// tests/ui-core/rename-target.test.ts — docs/UI.md "rename": a right-click on
// a local must rename THAT local (`reg:F:R`), not the enclosing function.
// `src/ui-core/rename-target.ts` is the whole mapping; the dialog only formats
// what it returns, so this is where the behaviour is pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameTargetFor, type LocalBinding } from "../../src/ui-core/rename-target.ts";

const locals: readonly LocalBinding[] = [
  { reg: 0, rendered: "r0", named: null, role: "passed", uses: 4 },
  { reg: 3, rendered: "count", named: "count", role: "passed", uses: 7 },
];

test("a clicked register ident targets that register", () => {
  const t = renameTargetFor(188, "r0", locals);
  assert.equal(t.target, "reg:188:0");
  assert.equal(t.kind, "reg");
  assert.equal(t.reg, 0);
  assert.equal(t.uses, 4);
  assert.equal(t.fellBack, false);
});

test("a clicked already-renamed ident targets its register, not the function", () => {
  const t = renameTargetFor(188, "count", locals);
  assert.equal(t.target, "reg:188:3");
  assert.equal(t.uses, 7);
});

test("the accepted name resolves even when the rendered column is stale", () => {
  const stale: readonly LocalBinding[] = [{ reg: 3, rendered: "r3", named: "count", role: "passed", uses: 7 }];
  assert.equal(renameTargetFor(188, "count", stale).target, "reg:188:3");
});

test("a token that is no nameable local falls back to the function, and says so", () => {
  const t = renameTargetFor(188, "console", locals);
  assert.equal(t.target, "fn:188");
  assert.equal(t.kind, "fn");
  assert.equal(t.fellBack, true);
  assert.equal(t.token, "console");
});

test("no token (or no listing yet) is a plain function rename, not a fallback", () => {
  for (const t of [renameTargetFor(188, undefined, locals), renameTargetFor(188, "  ", locals), renameTargetFor(188, "r0", undefined)]) {
    assert.equal(t.target, "fn:188");
    assert.equal(t.kind, "fn");
  }
  assert.equal(renameTargetFor(188, undefined, locals).fellBack, false);
  // a token with no listing is not yet a fallback decision either — the
  // dialog waits for `/locals` before saying anything (RenameDialog `pending`)
  assert.equal(renameTargetFor(188, "r0", undefined).fellBack, true);
});
