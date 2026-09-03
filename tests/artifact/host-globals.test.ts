// tests/artifact/host-globals.test.ts — A10 (docs/specs/10-artifact-format.md
// §7/§2.5, §9 ruling 2): the curated host-global list is pinned exactly (any
// change is a reviewed commit, never a silent drift), and an UNLISTED global
// read/called in >= 3 distinct functions is auto-surfaced as `host-global?`
// (a marked candidate) — never silently promoted to `host-global`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOST_GLOBALS, HOST_GLOBALS_SET } from "../../src/artifact/host-globals.ts";
import { buildNativeIndex } from "../../src/artifact/native.ts";
import type { GlobalRow } from "../../src/artifact/schema.ts";

test("A10 the curated host-global list is pinned exactly — governance is a reviewed commit, never a silent edit", () => {
  assert.deepEqual(
    [...HOST_GLOBALS].sort(),
    ["HermesInternal", "WebSocket", "XMLHttpRequest", "__fbBatchedBridge", "__turboModuleProxy", "fetch", "nativeCallSyncHook", "nativeLoggingHook"].sort(),
  );
  assert.equal(HOST_GLOBALS_SET.size, HOST_GLOBALS.length, "no duplicate entries");
});

test("A10 a curated global always yields surface:\"host-global\", never \"host-global?\"", () => {
  const globalRows: GlobalRow[] = [{ g: "fetch", fn: 1, access: "call", n: 1 }];
  const rows = buildNativeIndex([], globalRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.surface, "host-global");
  assert.equal(rows[0]!.name, "g:fetch");
});

test("A10 an unlisted global used (read/call) in >= 3 distinct functions is auto-surfaced as \"host-global?\", never \"host-global\"", () => {
  assert.ok(!HOST_GLOBALS_SET.has("__notARealHostGlobal__"), "test fixture must not collide with the curated list");
  const globalRows: GlobalRow[] = [
    { g: "__notARealHostGlobal__", fn: 1, access: "read", n: 1 },
    { g: "__notARealHostGlobal__", fn: 2, access: "read", n: 1 },
    { g: "__notARealHostGlobal__", fn: 3, access: "call", n: 1 },
  ];
  const rows = buildNativeIndex([], globalRows);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.surface, "host-global?");
    assert.equal(row.name, "g:__notARealHostGlobal__");
  }
});

test("A10 an unlisted global used in only 1-2 functions is never surfaced at all (below the auto-surface threshold)", () => {
  const globalRows: GlobalRow[] = [
    { g: "__rareGlobal__", fn: 1, access: "read", n: 1 },
    { g: "__rareGlobal__", fn: 2, access: "read", n: 1 },
  ];
  const rows = buildNativeIndex([], globalRows);
  assert.equal(rows.length, 0);
});

test("A10 a write-only access to an unlisted global never counts toward the auto-surface threshold (shadowing, not touching the host boundary)", () => {
  const globalRows: GlobalRow[] = [
    { g: "__writeOnlyGlobal__", fn: 1, access: "write", n: 1 },
    { g: "__writeOnlyGlobal__", fn: 2, access: "write", n: 1 },
    { g: "__writeOnlyGlobal__", fn: 3, access: "write", n: 1 },
  ];
  const rows = buildNativeIndex([], globalRows);
  assert.equal(rows.length, 0);
});
