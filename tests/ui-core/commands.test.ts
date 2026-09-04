// tests/ui-core/commands.test.ts — bur 5 (docs/UI-BURS.md #5): the pure
// ":" command-line parser (src/ui-core/commands.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCommand, fuzzyMatchIds, isCommandQuery, parseCommand } from "../../src/ui-core/commands.ts";

test("isCommandQuery: only a leading ':' is command mode", () => {
  assert.equal(isCommandQuery(":fn 1"), true);
  assert.equal(isCommandQuery("fn 1"), false);
  assert.equal(isCommandQuery(""), false);
});

test("parseCommand: verbs with well-formed arguments", () => {
  assert.deepEqual(parseCommand(":fn 74"), { kind: "fn", n: 74 });
  assert.deepEqual(parseCommand("fn 74"), { kind: "fn", n: 74 }); // leading ":" optional
  assert.deepEqual(parseCommand(":mod 5"), { kind: "mod", id: 5 });
  assert.deepEqual(parseCommand(":goto handleClick"), { kind: "goto", name: "handleClick" });
  assert.deepEqual(parseCommand(":goto handle Click"), { kind: "goto", name: "handle Click" });
  assert.deepEqual(parseCommand(":q"), { kind: "quit" });
  assert.deepEqual(parseCommand(":set theme dracula"), { kind: "set", what: "theme", value: "dracula" });
  assert.deepEqual(parseCommand(":set keymap vim"), { kind: "set", what: "keymap", value: "vim" });
});

test("parseCommand: malformed or partial verbs fall back to an action query", () => {
  assert.deepEqual(parseCommand(":fn"), { kind: "action", query: "fn" });
  assert.deepEqual(parseCommand(":fn abc"), { kind: "action", query: "fn abc" });
  assert.deepEqual(parseCommand(":mod"), { kind: "action", query: "mod" });
  assert.deepEqual(parseCommand(":goto"), { kind: "action", query: "goto" });
  assert.deepEqual(parseCommand(":q now"), { kind: "action", query: "q now" });
  assert.deepEqual(parseCommand(":set theme"), { kind: "action", query: "set theme" });
  assert.deepEqual(parseCommand(":set color dracula"), { kind: "action", query: "set color dracula" });
  assert.deepEqual(parseCommand(":"), { kind: "action", query: "" });
  assert.deepEqual(parseCommand(":annotate.rename"), { kind: "action", query: "annotate.rename" });
});

test("describeCommand: a human line per verb, undefined for a plain action query", () => {
  assert.equal(describeCommand({ kind: "fn", n: 74 }), "Open function 74");
  assert.equal(describeCommand({ kind: "mod", id: 5 }), "Open module 5");
  assert.equal(describeCommand({ kind: "goto", name: "handleClick" }), 'Go to the first function named "handleClick"');
  assert.equal(describeCommand({ kind: "quit" }), "Close the active panel / dialog");
  assert.equal(describeCommand({ kind: "set", what: "theme", value: "dracula" }), 'Set theme to "dracula"');
  assert.equal(describeCommand({ kind: "action", query: "x" }), undefined);
});

test("fuzzyMatchIds: subsequence match, case-insensitive, empty query matches everything", () => {
  const ids = ["navigate.definition", "navigate.xrefs", "annotate.rename", "project.search"];
  assert.deepEqual(fuzzyMatchIds("", ids), ids);
  assert.deepEqual(fuzzyMatchIds("nvd", ids), ["navigate.definition"]);
  assert.deepEqual(fuzzyMatchIds("ANRE", ids), ["annotate.rename"]);
  assert.deepEqual(fuzzyMatchIds("zzz", ids), []);
  assert.deepEqual(fuzzyMatchIds("search", ids), ["project.search"]);
});
