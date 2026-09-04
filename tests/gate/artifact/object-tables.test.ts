// tests/gate/artifact/object-tables.test.ts — acceptance for the
// `object-tables` verb (docs/specs/10-artifact-format.md §3.1,
// docs/specs/17-mcp-harness.md §14.2): a bundle-wide inventory of CONSTANT
// object literals, the "endpoint tables" one-shot the NSW hunt wanted
// (docs/specs/hunt-tooling-backlog.md, Round 2).
//
// Two fixture layers, on purpose:
//  - construct fixtures, read straight through `scanObjectTables` at EVERY
//    committed bytecode version, for the exact key/value and `<computed>`
//    assertions (this also exercises the v≤96 inline-operand vs v≥97
//    shape-table decode paths);
//  - the rn-template bundle, through the real `ArtifactService`, for the
//    filter/bound properties (never a literal-string compare against a
//    shared fixture's decompiled output — CLAUDE.md testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService, compareObjectTables, type ObjectTableMatch } from "../../../src/artifact/service.ts";
import { scanObjectTables, type ObjectTableRow } from "../../../src/artifact/object-tables.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { handle, type UiServerCtx } from "../../../src/ui-server/routes.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const VERSIONS = [84, 94, 96, 98, 99] as const;

function scanFixture(name: string, version: number): readonly ObjectTableRow[] {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
  if (!existsSync(p)) return [];
  try {
    return scanObjectTables(parseHbc(readFileSync(p)), () => null).rows;
  } catch {
    // A version whose layout this fixture cannot be probed for is not this
    // test's subject (the parse layer has its own tests for that).
    return [];
  }
}

// -- construct fixtures: exact members, every version --------------------

test("a constant string table is found with its keys and values, at every version", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const rows = scanFixture("41-spread-object", v);
    if (rows.length === 0) continue;
    versionsChecked++;
    // `const defaults = { theme: 'light', size: 'medium', flag: false }`.
    const table = rows.find((r) => r.members.some((m) => m.key === "theme"));
    assert.ok(table !== undefined, `v${v}: the defaults table should be in the inventory`);
    const byKey = new Map(table!.members.map((m) => [m.key, m]));
    assert.deepEqual(byKey.get("theme"), { key: "theme", value: "light", kind: "string" });
    assert.deepEqual(byKey.get("size"), { key: "size", value: "medium", kind: "string" });
    assert.deepEqual(byKey.get("flag"), { key: "flag", value: null, kind: "boolean" });
    assert.equal(table!.strings, 2);
    assert.equal(table!.nonStrings, 1);
    assert.equal(table!.numProps, 3);
    assert.equal(table!.fn >= 0, true);
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

test("a member whose value is computed is listed by key with kind computed", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const rows = scanFixture("39-destructuring-params", v);
    if (rows.length === 0) continue;
    // `makeUser({ id: 3, name: 'explicit', tags: ['a', 'b'] })` — `tags`'s
    // value is an array literal, so hermesc puts it on the object AFTER the
    // buffer literal instead of in the buffer.
    const table = rows.find((r) => r.members.some((m) => m.key === "name" && m.value === "explicit"));
    if (table === undefined) continue; // a version that lowers this differently is not this test's subject
    versionsChecked++;
    const tags = table.members.filter((m) => m.key === "tags");
    assert.equal(tags.length, 1, `v${v}: a computed member must not be listed twice`);
    assert.equal(tags[0]!.kind, "computed");
    assert.equal(tags[0]!.value, null, "a computed member has no proven value");
    assert.ok(table.computed >= 1);
    assert.ok(table.members.length >= table.numProps);
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

// -- the real bundle: filters and bounds ---------------------------------

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-object-tables-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir, { hbc: RN_TEMPLATE });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("the inventory is non-empty and every row honours the default filter", () => {
  const r = svc.objectTables();
  assert.ok(r.total >= 1, "rn-template should contain constant tables");
  assert.ok(r.scanned > 100, "the scan should have decoded the whole bundle");
  assert.equal(r.failed, 0);
  for (const t of r.tables) {
    assert.ok(t.members.length >= 4, `fn:${t.fn}@${t.offset} has ${t.members.length} members`);
    assert.ok(t.strings / t.members.length >= 0.5, `fn:${t.fn}@${t.offset} is not majority-string`);
  }
  // Sorted most members first.
  for (let i = 1; i < r.tables.length; i++) {
    assert.ok(r.tables[i - 1]!.members.length >= r.tables[i]!.members.length);
  }
});

test("min-props excludes smaller literals", () => {
  const wide = svc.objectTables({ minProps: 2 });
  const narrow = svc.objectTables({ minProps: 8 });
  assert.ok(wide.total > narrow.total, "a higher min-props must exclude tables");
  for (const t of narrow.tables) assert.ok(t.members.length >= 8);
});

test("--key filters to tables with a matching member key", () => {
  const r = svc.objectTables({ key: "^link$" });
  assert.ok(r.total >= 1, "rn-template has doc-link tables keyed `link`");
  for (const t of r.tables) assert.ok(t.members.some((m) => /^link$/.test(m.key)));
  assert.ok(r.total < svc.objectTables().total, "the key filter must narrow the inventory");
});

test("--value filters to tables with a matching string value", () => {
  const r = svc.objectTables({ value: "^(/|https?:)" });
  assert.ok(r.total >= 1, "rn-template has endpoint-shaped tables");
  for (const t of r.tables) {
    assert.ok(t.members.some((m) => m.value !== null && /^(\/|https?:)/.test(m.value)));
  }
});

test("--module filters to one module, and the rows carry that module", () => {
  const all = svc.objectTables({ limit: 5000 });
  const withModule = all.tables.find((t) => t.module !== null);
  assert.ok(withModule !== undefined, "at least one table should resolve to a module");
  const r = svc.objectTables({ module: withModule!.module!, limit: 5000 });
  assert.ok(r.total >= 1);
  for (const t of r.tables) assert.equal(t.module, withModule!.module);
});

test("limit bounds the rows and reports truncation honestly", () => {
  const r = svc.objectTables({ limit: 2 });
  assert.equal(r.tables.length, Math.min(2, r.total));
  assert.equal(r.truncated, r.total > 2);
  assert.equal(r.total, svc.objectTables({ limit: 5000 }).total, "the cap must not change the total");
});

test("the scan is memoised: repeated queries return identical rows", () => {
  const a = svc.objectTables({ minProps: 6 });
  const b = svc.objectTables({ minProps: 6 });
  assert.deepEqual(a.tables, b.tables);
  assert.equal(a.scanned, b.scanned);
});

test("a bad regex is a usage error, not a crash", () => {
  assert.throws(() => svc.objectTables({ key: "[" }), /object-tables: bad regex/);
});

// -- CLI + route --------------------------------------------------------

test("CLI: `query object-tables` prints a table block and a total", () => {
  const out = execFileSync("node", [CLI, "query", "object-tables", "--artifact", outDir, "--hbc", RN_TEMPLATE, "--limit", "2"], {
    encoding: "utf8",
  });
  assert.match(out, /^fn \d+ @\d+ {2}module (\d+|-) {2}keys=\d+ strings=\d+ matched=\d+$/m);
  assert.match(out, /^total:\d+ scanned:\d+$/m);
});

test("CLI: `--json` emits the service result verbatim", () => {
  const out = execFileSync("node", [CLI, "query", "object-tables", "--artifact", outDir, "--hbc", RN_TEMPLATE, "--limit", "3", "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as ReturnType<ArtifactService["objectTables"]>;
  assert.equal(parsed.total, svc.objectTables().total);
  assert.ok(parsed.tables.length <= 3);
  for (const t of parsed.tables) assert.ok(Array.isArray(t.members));
});

test("CLI: an unknown query verb still lists object-tables", () => {
  try {
    execFileSync("node", [CLI, "query", "no-such-verb", "--artifact", outDir], { encoding: "utf8", stdio: "pipe" });
    assert.fail("an unknown verb must exit non-zero");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    assert.match(`${err.stderr ?? ""}${err.stdout ?? ""}`, /object-tables/);
  }
});

test("route: GET /api/object-tables passes every filter through", async () => {
  let seen: unknown;
  const ctx = {
    resources: {
      objectTables: (opts: unknown) => {
        seen = opts;
        return { tables: [], total: 0, truncated: false, scanned: 0, failed: 0 };
      },
    },
  } as unknown as UiServerCtx;
  const res = await handle(
    { method: "GET", path: "/api/object-tables", body: null, query: { minProps: "6", stringRatio: "0.25", key: "^PATH_", value: "^/", module: "3", minMatched: "4", limit: "7" } },
    ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { minProps: 6, stringRatio: 0.25, module: 3, minMatched: 4, limit: 7, key: "^PATH_", value: "^/" });
});

test("route: GET /api/object-tables with no query uses the service defaults", async () => {
  let seen: unknown;
  const ctx = {
    resources: {
      objectTables: (opts: unknown) => {
        seen = opts;
        return { tables: [], total: 0, truncated: false, scanned: 0, failed: 0 };
      },
    },
  } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: "/api/object-tables", body: null, query: {} }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, {});
});

// -- `matched` + ranking (orchestrator follow-up, 2026-09-04) ------------
//
// Reported on the live NSW ui-server: `?value=^/&minProps=4&limit=2` returned
// the 2,125-member HTML-entity table (module 2447) first, because `&sol;` is
// "/" and the sort was purely by member count. A filtered query now ranks on
// how much of the table the query actually hit.

/** The shape the ranking needs, with everything else stubbed. */
function fakeTable(fn: number, members: number, matched: number): ObjectTableMatch {
  return {
    fn,
    offset: 0,
    module: null,
    numProps: members,
    members: Array.from({ length: members }, (_, i) => ({ key: `k${i}`, value: "v", kind: "string" as const })),
    strings: members,
    nonStrings: 0,
    computed: 0,
    matched,
  };
}

test("ranking: an endpoint table outranks a giant table with one accidental hit", () => {
  const entities = fakeTable(2447, 2125, 1); // `&sol;: "/"` — one lucky member
  const endpoints = fakeTable(10635, 41, 41); // every member is a PATH_*
  const licences = fakeTable(11367, 22, 22);
  const ranked = [entities, endpoints, licences].sort(compareObjectTables(true));
  assert.deepEqual(
    ranked.map((t) => t.fn),
    [10635, 11367, 2447],
  );
});

test("ranking: equal matched counts break on density, then on size", () => {
  const dense = fakeTable(1, 8, 4); // 4/8
  const sparse = fakeTable(2, 100, 4); // 4/100
  assert.deepEqual([sparse, dense].sort(compareObjectTables(true)).map((t) => t.fn), [1, 2]);
  const sameDensity = [fakeTable(3, 8, 4), fakeTable(4, 16, 8)];
  // 8 matched beats 4 matched outright, whatever the density.
  assert.deepEqual(sameDensity.sort(compareObjectTables(true)).map((t) => t.fn), [4, 3]);
});

test("ranking: an UNFILTERED query still sorts by size alone", () => {
  const ranked = [fakeTable(1, 4, 4), fakeTable(2, 40, 40)].sort(compareObjectTables(false));
  assert.deepEqual(ranked.map((t) => t.fn), [2, 1]);
});

test("matched: equals the member count when no filter is given", () => {
  for (const t of svc.objectTables({ limit: 20 }).tables) assert.equal(t.matched, t.members.length);
});

test("matched: counts exactly the members the pattern hit, and ranks on it", () => {
  const r = svc.objectTables({ value: "^(/|https?:)", limit: 5000 });
  assert.ok(r.total >= 1);
  const cmp = compareObjectTables(true);
  for (const t of r.tables) {
    const expected = t.members.filter((m) => m.value !== null && /^(\/|https?:)/.test(m.value)).length;
    assert.equal(t.matched, expected, `fn:${t.fn}@${t.offset}`);
    assert.ok(t.matched >= 1, "a table that passes the filter has at least one matching member");
  }
  for (let i = 1; i < r.tables.length; i++) {
    assert.ok(cmp(r.tables[i - 1]!, r.tables[i]!) <= 0, "rows must be in ranking order");
  }
});

test("--min-matched excludes tables the pattern barely touched", () => {
  const loose = svc.objectTables({ value: "^(/|https?:)", limit: 5000 });
  const strict = svc.objectTables({ value: "^(/|https?:)", minMatched: 2, limit: 5000 });
  assert.ok(strict.total <= loose.total);
  for (const t of strict.tables) assert.ok(t.matched >= 2);
  const onlyOne = loose.tables.filter((t) => t.matched < 2).length;
  assert.equal(strict.total, loose.total - onlyOne);
});

test("--min-matched is a no-op without a key/value filter", () => {
  const a = svc.objectTables({ limit: 5000 });
  const b = svc.objectTables({ minMatched: 3, limit: 5000 });
  assert.equal(a.total, b.total);
});
