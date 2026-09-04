// tests/gate/ui/xref-who-calls-by-name.test.ts — spec 17 §14.1's
// `who-calls-by-name` surfaced in the Xrefs tab (ca0a9cd landed the server
// verb; this is the UI half). Same style as tests/gate/ui/xref-strings.test.ts:
// pure file scanning plus dynamic `import()` of mock.ts, which has no
// runtime dependency on `ui/node_modules` (only `import type`, erased by TS
// type-stripping), so this runs under the root `npm test` gate with no
// `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const ui = (...p: string[]): string => join(root, "ui", ...p);
const read = (...p: string[]): string => readFileSync(ui(...p), "utf8");

// -- 1. the contract shapes exist ---------------------------------------

test("contracts.ts declares the xref/who-calls-by-name shapes", () => {
  const src = read("src", "contracts.ts");
  for (const name of ["ByNameCaller", "ByNameEntry", "WhoCallsByName"]) {
    assert.match(src, new RegExp(String.raw`export (?:interface|type) ${name}\b`), `contracts.ts must export ${name}`);
  }
  // Every row's confidence is the literal "by-name" — never a resolved edge.
  assert.match(src, /confidence:\s*"by-name"/);
});

// -- 2. api.ts's Api surface + route table cover the route ---------------

test("api.ts declares and routes xrefWhoCallsByName", () => {
  const src = read("src", "api.ts");
  assert.match(src, /xrefWhoCallsByName\(fn: number\): Promise<WhoCallsByName>/);
  assert.match(src, /xrefWhoCallsByName:\s*\(fn\)\s*=>\s*get\(`\/xref\/who-calls-by-name`,\s*\{\s*fn\s*\}\)/);
});

// -- 3. the mock adapter answers with a plausible, capped shape -----------

test("mockApi.xrefWhoCallsByName returns a Bounded<ByNameCaller> with names[]/excludedModule, and can be ambiguous", async () => {
  const m = await import(pathToFileURL(ui("src", "mock.ts")).href) as { mockApi: Record<string, (...a: unknown[]) => Promise<unknown>> };
  const r = await m.mockApi["xrefWhoCallsByName"]!(3) as {
    rows: { fn: number; callerName: string | null; size: number | null; name: string; role: string; n: number; file: string | null; line: number | null; confidence: string }[];
    total: number; truncated: boolean;
    names: { name: string; sid: number | null; ambiguous: boolean; why?: string }[];
    excludedModule: number | null;
  };
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.total, r.rows.length);
  assert.equal(typeof r.truncated, "boolean");
  assert.ok(Array.isArray(r.names));
  for (const row of r.rows) {
    assert.equal(row.confidence, "by-name", "every row must carry confidence:\"by-name\", never a resolved edge");
    assert.equal(typeof row.fn, "number");
  }

  // The ambiguous path: no candidate rows, an explanatory `why`.
  const ambiguous = await m.mockApi["xrefWhoCallsByName"]!(999) as {
    rows: unknown[]; total: number; names: { ambiguous: boolean; why?: string }[];
  };
  assert.equal(ambiguous.rows.length, 0);
  assert.ok(ambiguous.names.some((n) => n.ambiguous === true), "the mock must exercise the ambiguous-name path");
  assert.ok(ambiguous.names.find((n) => n.ambiguous)?.why !== undefined, "an ambiguous name must carry a `why`");
});

// -- 4. the Xrefs tab wires it in, below the exact callers -----------------

test("RightPane.tsx fetches who-calls-by-name lazily, only while the Xrefs tab is visible", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.match(src, /useWhoCallsByName\(fn,\s*hasFn\s*&&\s*panel\s*===\s*"xrefs"\)/);
});

test("RightPane.tsx labels the section as heuristic, jumps like an exact caller row, and explains the ambiguous state instead of drawing rows", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.match(src, /Callers by name \(heuristic\)/);
  // ByNameRow jumps exactly like XrefRow: select({kind:"fn", fn}).
  assert.match(src, /function ByNameRow[\s\S]*?select\(\{\s*kind:\s*"fn",\s*fn:\s*row\.fn\s*\}\)/);
  // The ambiguous state renders an explanation, not rows.
  assert.match(src, /ambiguous\.why/);
});

test("RightPane.tsx hides the by-name section when the exact callers are non-empty and the by-name result is empty", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.match(src, /callers\.data\?\.total\s*\?\?\s*0\)\s*>\s*0\)\s*&&\s*byName\.data\s*!==\s*undefined\s*&&\s*byName\.data\.rows\.length\s*===\s*0/);
});

test("RightPane.tsx names no literal colours in the by-name section (tokens only)", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, "RightPane.tsx must not hard-code a hex colour");
  assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|red|blue|green)-\d/, "RightPane.tsx must not use a literal Tailwind colour class");
});

// -- 5. docs/UI.md documents it as candidates, not proven callers ----------

test("docs/UI.md's Xrefs section documents who-calls-by-name as candidates, not proven callers", () => {
  const src = readFileSync(join(root, "docs", "UI.md"), "utf8");
  assert.match(src, /who-calls-by-name/);
  assert.match(src, /candidates?,?\s+not\s+proven\s+callers/i);
});
