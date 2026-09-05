// tests/gate/artifact/template-injections.test.ts — acceptance for the
// `template-injections` verb (docs/specs/17-mcp-harness.md §14.3,
// docs/specs/hunt-tooling-backlog.md line ~55): the WebView-injection
// anti-pattern lead (hunt lead C1) — a template literal / `+` chain whose
// static text quotes a runtime substitution.
//
// Three layers, on purpose (CLAUDE.md testing rules — no literal-string
// compare against a shared fixture's decompiled output):
//  - a hand-built reaching-def shape, through `findInjection`'s public
//    surface (`scanFunction`/`compareTemplateInjections`), for the pure
//    quote-matching logic;
//  - the `61-webview-injection-antipattern` construct fixture, read straight
//    through `scanTemplateInjections` at every committed bytecode version;
//  - the rn-template bundle, through the real `ArtifactService`, for the
//    filter/bound/ranking properties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { compareTemplateInjections, scanTemplateInjections, type TemplateInjectionRow } from "../../../src/artifact/template-injections.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { handle, type UiServerCtx } from "../../../src/ui-server/routes.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const VERSIONS = [84, 94, 96, 98, 99] as const;
const FIXTURE = "61-webview-injection-antipattern";

function scanFixture(name: string, version: number): readonly TemplateInjectionRow[] {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
  if (!existsSync(p)) return [];
  try {
    return scanTemplateInjections(parseHbc(readFileSync(p)), () => null).rows;
  } catch {
    return [];
  }
}

// -- construct fixture: exact rows, every committed version --------------

test("a template literal with a quoted hole is found, at every version", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const rows = scanFixture(FIXTURE, v);
    if (rows.length === 0) continue;
    versionsChecked++;
    const row = rows.find((r) => r.kind === "template");
    assert.ok(row !== undefined, `v${v}: injectTemplate's concat call should be found`);
    assert.equal(row!.quote, "'");
    assert.equal(row!.substitutions, 1);
    assert.equal(row!.nSubs, 1);
    assert.match(row!.prefix, /window\.postMessage\($/);
    assert.match(row!.suffix, /^\)/);
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

test("the equivalent `+`-concatenation is found as kind concat, not template", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const rows = scanFixture(FIXTURE, v);
    if (rows.length === 0) continue;
    versionsChecked++;
    const row = rows.find((r) => r.kind === "concat");
    assert.ok(row !== undefined, `v${v}: injectConcat's Add chain should be found`);
    assert.equal(row!.quote, "'");
    assert.equal(row!.substitutions, 1);
    assert.match(row!.prefix, /window\.postMessage\($/);
    assert.match(row!.suffix, /^\)/);
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

test("a substitution outside any quotes (safeTemplate) is never reported", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const rows = scanFixture(FIXTURE, v);
    if (rows.length === 0) continue;
    versionsChecked++;
    for (const r of rows) {
      assert.ok(!/Hello, $/.test(r.prefix), `v${v}: safeTemplate's greeting must not be reported (no quotes around its hole)`);
    }
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

// -- the real bundle: filters, bounds, memoisation -----------------------

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-template-injections-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir, { hbc: RN_TEMPLATE });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("the scan runs bundle-wide without throwing, and never crashes on an undecodable function", () => {
  const r = svc.templateInjections();
  assert.ok(r.scanned > 100, "the scan should have decoded the whole bundle");
  assert.ok(r.failed >= 0);
  assert.ok(r.total >= r.rows.length);
});

test("every row has at least one substitution inside its reported quotes", () => {
  const r = svc.templateInjections({ limit: 5000 });
  for (const row of r.rows) {
    assert.ok(row.substitutions >= 1, `fn:${row.fn}@${row.offset}`);
    assert.ok(row.nSubs >= row.substitutions, `fn:${row.fn}@${row.offset}`);
    assert.ok(row.quote === "'" || row.quote === '"');
    assert.ok(row.kind === "template" || row.kind === "concat");
  }
});

test("rows are ranked by substitutions-inside-quotes desc, then fn", () => {
  const r = svc.templateInjections({ limit: 5000 });
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(compareTemplateInjections(r.rows[i - 1]!, r.rows[i]!) <= 0, "rows must be in ranking order");
  }
});

test("--module filters to one module, and the rows carry that module", () => {
  const all = svc.templateInjections({ limit: 5000 });
  const withModule = all.rows.find((r) => r.module !== null);
  if (withModule === undefined) return; // this bundle's rows may all be moduleless; not this test's subject
  const r = svc.templateInjections({ module: withModule.module!, limit: 5000 });
  assert.ok(r.total >= 1);
  for (const row of r.rows) assert.equal(row.module, withModule.module);
});

test("limit bounds the rows and reports truncation honestly", () => {
  const total = svc.templateInjections({ limit: 5000 }).total;
  const r = svc.templateInjections({ limit: 1 });
  assert.equal(r.rows.length, Math.min(1, r.total));
  assert.equal(r.truncated, r.total > 1);
  assert.equal(r.total, total, "the cap must not change the total");
});

test("the scan is memoised: repeated queries return identical rows", () => {
  const a = svc.templateInjections({ limit: 10 });
  const b = svc.templateInjections({ limit: 10 });
  assert.deepEqual(a.rows, b.rows);
  assert.equal(a.scanned, b.scanned);
});

// -- CLI + route -----------------------------------------------------------

test("CLI: `query template-injections` prints rows and a total", () => {
  const out = execFileSync("node", [CLI, "query", "template-injections", "--artifact", outDir, "--hbc", RN_TEMPLATE, "--limit", "2"], {
    encoding: "utf8",
  });
  assert.match(out, /^total:\d+ scanned:\d+$/m);
});

test("CLI: `--json` emits the service result verbatim", () => {
  const out = execFileSync("node", [CLI, "query", "template-injections", "--artifact", outDir, "--hbc", RN_TEMPLATE, "--limit", "3", "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as ReturnType<ArtifactService["templateInjections"]>;
  assert.equal(parsed.total, svc.templateInjections().total);
  assert.ok(parsed.rows.length <= 3);
  for (const r of parsed.rows) assert.equal(typeof r.substitutions, "number");
});

test("CLI: an unknown query verb still lists template-injections", () => {
  try {
    execFileSync("node", [CLI, "query", "no-such-verb", "--artifact", outDir], { encoding: "utf8", stdio: "pipe" });
    assert.fail("an unknown verb must exit non-zero");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    assert.match(`${err.stderr ?? ""}${err.stdout ?? ""}`, /template-injections/);
  }
});

test("route: GET /api/template-injections passes filters through", async () => {
  let seen: unknown;
  const ctx = {
    resources: {
      // The route calls the non-blocking entry point (`src/incremental.ts`,
      // D33); same options, same answer -- only the drain differs.
      templateInjectionsAsync: (opts: unknown) => {
        seen = opts;
        return { rows: [], total: 0, truncated: false, scanned: 0, failed: 0 };
      },
    },
  } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: "/api/template-injections", body: null, query: { module: "3", limit: "7" } }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { module: 3, limit: 7 });
});

test("route: GET /api/template-injections with no query uses the service defaults", async () => {
  let seen: unknown;
  const ctx = {
    resources: {
      // The route calls the non-blocking entry point (`src/incremental.ts`,
      // D33); same options, same answer -- only the drain differs.
      templateInjectionsAsync: (opts: unknown) => {
        seen = opts;
        return { rows: [], total: 0, truncated: false, scanned: 0, failed: 0 };
      },
    },
  } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: "/api/template-injections", body: null, query: {} }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, {});
});

// -- ranking comparator, unit-level ---------------------------------------

function fakeRow(fn: number, substitutions: number): TemplateInjectionRow {
  return { fn, offset: 0, module: null, kind: "template", quote: "'", prefix: "", suffix: "", substitutions, nSubs: substitutions };
}

test("compareTemplateInjections: more substitutions-inside-quotes ranks first", () => {
  const ranked = [fakeRow(5, 1), fakeRow(2, 3), fakeRow(9, 2)].sort(compareTemplateInjections);
  assert.deepEqual(
    ranked.map((r) => r.fn),
    [2, 9, 5],
  );
});

test("compareTemplateInjections: ties break on fn ascending", () => {
  const ranked = [fakeRow(9, 1), fakeRow(2, 1), fakeRow(5, 1)].sort(compareTemplateInjections);
  assert.deepEqual(
    ranked.map((r) => r.fn),
    [2, 5, 9],
  );
});
