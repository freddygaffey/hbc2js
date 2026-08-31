// CLAUDE.md "Testing rules" (docs/CONSOLIDATION.md §B items 7 and 10).
// Mechanical enforcement in the style of tests/gate/passes/imports.test.ts:
// walk source text, flag violations, never invert or delete an existing
// assertion — a pre-existing violation this task cannot fix in budget is
// allow-listed below with a docs/BUGS.md citation, not silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const passesDir = join(repoRoot(), "tests", "gate", "passes");
const bugsText = readFileSync(join(repoRoot(), "docs", "BUGS.md"), "utf8");

/**
 * Rule 7 — no exact-output assertions on shared fixtures
 * (`tests/fixtures/constructs/**`); a rung test asserts rung-owned
 * properties or uses a rung-private fixture.
 *
 * WHAT THIS CATCHES: inside one `test(...)` body in
 * `tests/gate/passes/*.test.ts`, a call to `assert.equal` / `assert.strictEqual`
 * / `assert.deepEqual` whose argument list contains a "whole-program golden"
 * literal — a template literal with a real embedded newline
 * (`` assert.strictEqual(out, `line1\nline2`) `` written with an actual line
 * break) or a quoted string with two or more `\n` escapes (`assert.equal(x,
 * "line1\nline2\nline3")`) — in a test body that itself decompiles a shared
 * fixture (calls a local `fixture(...)` helper whose own body reads from
 * `tests/fixtures/constructs`, or spells that path inline). Also flags any
 * `.snap`/`.golden` file under `tests/gate/passes/**`, since a snapshot file
 * is definitionally a whole-output golden.
 *
 * WHAT THIS DOES NOT CATCH:
 *  - a golden assertion whose fixture bytes reach `decompile()` through a
 *    helper more indirect than "call a function literally named `fixture`"
 *    (e.g. piped through an unrelated intermediate function, or fixture
 *    bytes embedded as a literal in the test file itself) — this is a
 *    text-shape heuristic, not a data-flow analysis;
 *  - a golden built by concatenating several short literals across
 *    variables rather than one literal in the assert call itself;
 *  - a single-line escaped literal with exactly one `\n` (below the
 *    two-escape threshold) that is nonetheless a two-line golden;
 *  - `assert.deepEqual`/`assert.equal` against an array or object whose
 *    *values* happen to be multi-line strings but which is not itself a
 *    string/template literal at the call site (e.g. compares a variable
 *    built earlier) — only literals typed directly into the call are seen.
 * Any of these would need the same manual read that caught the pattern in
 * the first place; this test is a floor, not a proof.
 */

const TEST_CALL_RE = /(?<![.\w])test\(\s*["'`]/g;
const ASSERT_CALL_RE = /\bassert\.(equal|strictEqual|deepEqual)\(/g;
const SHARED_FIXTURE_PATH_RE = /["']fixtures["']\s*,\s*["']constructs["']|fixtures[/\\]constructs/;

/** Index just after the bracket matching the one at `openIdx`, treating any
 *  quoted/backtick span as opaque (so a brace or paren inside a string never
 *  perturbs the count). Returns -1 if unmatched. Shared by rule 7's call-body
 *  extraction and rule 10's Set-literal extraction below. */
function matchingClose(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level quoted/backtick literals inside `text` (no recursion into a
 *  template's `${...}` interpolations — good enough to spot the golden
 *  shape, not a full parser). */
function literalsIn(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < text.length && text[j] !== q) {
        if (text[j] === "\\") j++;
        j++;
      }
      out.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** A literal that looks like a whole emitted program pasted in as the
 *  expected value: a template literal with a real line break, or a quoted
 *  string carrying two or more `\n` escapes. */
function isWholeProgramLiteral(raw: string): boolean {
  if (raw.startsWith("`")) return raw.includes("\n");
  return (raw.match(/\\n/g) ?? []).length >= 2;
}

/** `{ name, body }` for every `test("name", ... => { ... })` in `text`. */
function testBodies(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of text.matchAll(TEST_CALL_RE)) {
    const nameStart = m.index! + m[0].length - 1;
    const quote = text[nameStart]!;
    let nameEnd = -1;
    for (let i = nameStart + 1; i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === quote) {
        nameEnd = i;
        break;
      }
    }
    const name = nameEnd === -1 ? "<unparsed name>" : text.slice(nameStart + 1, nameEnd);
    const arrow = text.indexOf("=> {", m.index!);
    if (arrow === -1 || arrow > m.index! + 4000) continue; // not an arrow-callback test(); out of scope for this heuristic
    const braceStart = arrow + 3;
    const braceEnd = matchingClose(text, braceStart, "{", "}");
    if (braceEnd === -1) continue;
    out.push({ name, body: text.slice(braceStart, braceEnd + 1) });
  }
  return out;
}

/** Whether `body` decompiles a shared `tests/fixtures/constructs/**` fixture:
 *  either the path is spelled inline, or the body calls a locally defined
 *  `fixture(...)` helper whose own source reads from that directory. */
function usesSharedFixture(fileText: string, body: string): boolean {
  if (SHARED_FIXTURE_PATH_RE.test(body)) return true;
  const helperMatch = /function fixture\(/.exec(fileText) ?? /const fixture\s*=/.exec(fileText);
  if (!helperMatch) return false;
  const braceStart = fileText.indexOf("{", helperMatch.index!);
  if (braceStart === -1) return false;
  const braceEnd = matchingClose(fileText, braceStart, "{", "}");
  if (braceEnd === -1) return false;
  const helperBody = fileText.slice(braceStart, braceEnd + 1);
  return SHARED_FIXTURE_PATH_RE.test(helperBody) && /\bfixture\(/.test(body);
}

function rule7ViolationsIn(fileRel: string, fileText: string): string[] {
  const out: string[] = [];
  for (const { name, body } of testBodies(fileText)) {
    if (!usesSharedFixture(fileText, body)) continue;
    for (const am of body.matchAll(ASSERT_CALL_RE)) {
      const openIdx = am.index! + am[0].length - 1;
      const closeIdx = matchingClose(body, openIdx, "(", ")");
      if (closeIdx === -1) continue;
      const callText = body.slice(openIdx, closeIdx + 1);
      if (literalsIn(callText).some(isWholeProgramLiteral)) {
        out.push(`${fileRel}: ${JSON.stringify(name)}`);
        break; // one flag per test body is enough
      }
    }
  }
  return out;
}

// Pre-existing violations this task could not rewrite in budget go here, each
// with a docs/BUGS.md citation. Empty today — the manual pass-file audit that
// accompanied this test found no shared-fixture whole-output golden in
// tests/gate/passes/*.test.ts (every fixture-driven assertion there already
// compares counts/regexes/structural properties, not literal output).
const RULE7_ALLOWLIST = new Set<string>([]);

test("testing rule 7: no whole-decompiled-output golden against a shared tests/fixtures/constructs fixture", () => {
  const violations: string[] = [];
  for (const entry of readdirSync(passesDir).filter((f) => f.endsWith(".test.ts"))) {
    const fileRel = `tests/gate/passes/${entry}`;
    const text = readFileSync(join(passesDir, entry), "utf8");
    for (const v of rule7ViolationsIn(fileRel, text)) if (!RULE7_ALLOWLIST.has(v)) violations.push(v);
  }
  assert.deepEqual(
    violations,
    [],
    "a test comparing the whole decompiled output of a shared fixture to a literal must instead assert a rung-owned " +
      "property (count/regex/structural check) or move to a rung-private fixture — or, if truly stuck, be added to " +
      "RULE7_ALLOWLIST here with a docs/BUGS.md row",
  );
});

/** No snapshot/golden files should exist under the pass test tree at all —
 *  rule 7 rules the whole shape out, not just literal-in-assert. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("testing rule 7: no .snap/.golden files under tests/gate/passes", () => {
  const snapshotLike = walk(passesDir).filter((p) => /\.(snap|golden)(\.\w+)?$/i.test(p));
  assert.deepEqual(snapshotLike, [], `snapshot/golden files are a rule-7 violation by construction: ${snapshotLike.join(", ")}`);
});

/**
 * Rule 10 — no fixture leaves the gate without a docs/BUGS.md row and an
 * owner; exclusion tables are debt.
 *
 * Every `new Set<string>([...])` (or `: Set<string> = new Set([...])`)
 * declaration in `src/harness/tiers.ts` whose name matches the
 * exclusion-table naming convention (`KNOWN_*`, or containing `EXCLUD`)
 * must have every one of its string entries appear verbatim somewhere in
 * docs/BUGS.md — the citation rule 10 requires. As of this task tiers.ts
 * carries no such table (the last ones, `KNOWN_WRONG_OUTPUT` and
 * `KNOWN_AMBIGUOUS_V98`, were deleted when their fixtures were fixed — see
 * docs/BUGS.md's 2026-08-31 rows), so this test currently passes vacuously;
 * it exists so the next exclusion table added there is caught immediately.
 */
const EXCLUSION_TABLE_RE = /\b(?:const|export const)\s+([A-Z][A-Z0-9_]*)\s*(?::\s*Set<string>\s*)?=\s*new Set(?:<string>)?\(\s*\[/g;
const EXCLUSION_NAME_RE = /KNOWN_|EXCLUD/;

function exclusionTables(text: string): { name: string; entries: string[] }[] {
  const out: { name: string; entries: string[] }[] = [];
  for (const m of text.matchAll(EXCLUSION_TABLE_RE)) {
    const name = m[1]!;
    if (!EXCLUSION_NAME_RE.test(name)) continue;
    const bracketIdx = m.index! + m[0].length - 1;
    const closeIdx = matchingClose(text, bracketIdx, "[", "]");
    if (closeIdx === -1) continue;
    const arrayText = text.slice(bracketIdx, closeIdx + 1);
    const entries = literalsIn(arrayText).map((raw) => raw.slice(1, -1));
    out.push({ name, entries });
  }
  return out;
}

test("testing rule 10: every src/harness/tiers.ts exclusion-table entry cites a docs/BUGS.md row", () => {
  const tiersPath = join(repoRoot(), "src", "harness", "tiers.ts");
  const tiersText = readFileSync(tiersPath, "utf8");
  const uncited: string[] = [];
  for (const { name, entries } of exclusionTables(tiersText)) {
    for (const entry of entries) if (!bugsText.includes(entry)) uncited.push(`${name}: ${JSON.stringify(entry)}`);
  }
  assert.deepEqual(uncited, [], `src/harness/tiers.ts exclusion-table entries with no docs/BUGS.md citation: ${uncited.join(", ")}`);
});
