// tests/gate/ui/fold-and-disasm.test.ts — docs/UI.md "Still rough here" used
// to list `view.fold` / `view.unfold` / `view.rawHermes` as status-line
// stubs; this test is what stops that regressing. Pure file scanning, like
// tests/gate/ui/listing.test.ts and tests/gate/ui/actions-registry.test.ts —
// runs under the root `npm test` with no `ui/node_modules` present, so it
// cannot import ui/src/listing/fold-store.ts or ui/src/panes/disasm-store.ts
// directly (both pull in @codemirror packages that live only in
// ui/node_modules); it asserts on source text instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const ui = (...p: string[]): string => join(repoRoot(), "ui", ...p);
const read = (...p: string[]): string => readFileSync(ui(...p), "utf8");

test("the registry no longer stubs fold/unfold/rawHermes with a bare status line", () => {
  const registry = read("src", "actions", "registry.ts");
  assert.doesNotMatch(registry, /folding is a listing follow-up/, "fold/unfold must no longer be a no-op stub");
  assert.doesNotMatch(
    registry,
    /raw Hermes is the centre pane's Disasm tab/,
    "showRawHermes must no longer be a no-op stub",
  );
  assert.match(registry, /foldActive\(\)/, "fold: must call the fold-store's foldActive()");
  assert.match(registry, /unfoldActive\(\)/, "unfold: must call the fold-store's unfoldActive()");
  assert.match(registry, /openDisasm\(\)/, "showRawHermes: must call the disasm-store's openDisasm()");
});

test("fold/unfold are gated on a fn-or-module selection, not always enabled", () => {
  // The gate used to be a UI-only override in registry.ts (registry.register()
  // overwriting by id); it now lives in the shared src/ui-core/actions.ts
  // definition itself, so every shell gets it — see tests/ui-core/actions.test.ts
  // for the behavioural assertion (enabled on module/fn/identifier-with-fn,
  // disabled on none/identifier-without-fn).
  const registry = read("src", "actions", "registry.ts");
  assert.doesNotMatch(
    registry,
    /registry\.register\(\{ \.\.\.action, when:/,
    "the view.fold/view.unfold when-gate moved into src/ui-core/actions.ts; registry.ts must not re-override it",
  );
  const coreActions = readFileSync(join(repoRoot(), "src", "ui-core", "actions.ts"), "utf8");
  assert.match(coreActions, /function hasListingTarget/, "src/ui-core/actions.ts must define the shared listing-target gate");
  assert.match(
    coreActions,
    /id: "view\.fold"[\s\S]{0,80}when: hasListingTarget/,
    "view.fold must be gated by hasListingTarget",
  );
  assert.match(
    coreActions,
    /id: "view\.unfold"[\s\S]{0,80}when: hasListingTarget/,
    "view.unfold must be gated by hasListingTarget",
  );
});

test("CodeView wires CodeMirror's fold gutter and registers with fold-store", () => {
  const codeView = read("src", "listing", "CodeView.tsx");
  assert.match(codeView, /codeFolding\(\)/, "CodeView must install codeFolding()");
  assert.match(codeView, /foldGutter\(\)/, "CodeView must install foldGutter()");
  assert.match(codeView, /foldKeymap/, "CodeView must include foldKeymap in its keymap extension");
  assert.match(codeView, /setActiveFoldView\(v\)/, "CodeView must register its view with fold-store on mount");
  assert.match(codeView, /setActiveFoldView\(null\)/, "CodeView must clear fold-store's registration on unmount");
  assert.match(codeView, /registerFold/, "CodeView must accept a registerFold prop so only the primary block registers");
});

test("fold-store.ts exposes foldActive/unfoldActive over @codemirror/language's foldAll/unfoldAll", () => {
  const store = read("src", "listing", "fold-store.ts");
  assert.match(store, /from "@codemirror\/language"/);
  assert.match(store, /export function setActiveFoldView/);
  assert.match(store, /export function foldActive/);
  assert.match(store, /export function unfoldActive/);
  assert.match(store, /foldAll\(active\)/);
  assert.match(store, /unfoldAll\(active\)/);
});

test("CenterPane's disasm panel is driven by a shared store, not local state", () => {
  const centerPane = read("src", "panes", "CenterPane.tsx");
  assert.doesNotMatch(
    centerPane,
    /useState\(true\)/,
    "disasmOpen must come from disasm-store's useDisasmOpen(), not a local useState",
  );
  assert.match(centerPane, /useDisasmOpen\(\)/, "CenterPane must read disasmOpen from disasm-store");
  assert.match(centerPane, /from "\.\/disasm-store\.ts"/, "CenterPane must import the disasm store");
  assert.match(centerPane, /registerFold/, "CenterPane's primary CodeView must set registerFold");

  const store = read("src", "panes", "disasm-store.ts");
  assert.match(store, /export function openDisasm/);
  assert.match(store, /export function useDisasmOpen/);
  assert.match(store, /export function setDisasmOpen/);
});

test("docs/UI.md no longer lists fold/unfold/rawHermes as status-line stubs", () => {
  const doc = readFileSync(join(repoRoot(), "docs", "UI.md"), "utf8");
  assert.doesNotMatch(
    doc,
    /`view\.fold` \/ `view\.unfold`, `view\.rawHermes` and `ai\.\*` are status-line stubs/,
    "docs/UI.md's 'Still rough here' bullet must be updated once fold/unfold/rawHermes are wired",
  );
});
