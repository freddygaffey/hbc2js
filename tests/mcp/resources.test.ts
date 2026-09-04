// tests/mcp/resources.test.ts — docs/specs/17-mcp-harness.md §1 (as revised
// §14): `src/mcp/resources.ts`'s `McpResources`, the transport-agnostic
// business-logic core of the READ resources. Builds a small-ish `.hbcproj`
// from a real bundle fixture via the `hbc2js init` path directly
// (splitProject + buildIndexRows + initProjectDb, the same three calls
// `runInit` in src/cli.ts makes), then asserts shape/cap/neighbour-inlining
// — no literal-string compare against a shared fixture's decompiled output
// (CLAUDE.md / docs/CONSOLIDATION.md §B testing rules).
//
// Fixture note: this rung uses `rn-template-0.72` rather than a
// `tests/fixtures/constructs/**` construct fixture. `splitProject`'s
// `functionRanges` (the source of `ix_ranges`, so of `source`/`disasm`/
// `context`) is populated per-module from the `__d(factory, id, deps)`
// module-split loop (src/split/index.ts) — a single-script construct
// fixture has zero CJS modules, so it gets zero ranges from `--split`/
// `init` and cannot exercise the source-emitting resources at all. Not
// fixed here (out of this rung's scope; a real bundle sidesteps it, same
// as `tests/artifact/query-bounds.test.ts` and `tests/projdb/init.test.ts`
// already do for the same reason).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { dbSetTag } from "../../src/projdb/annotations.ts";
import { openProjectDbReadonly } from "../../src/projdb/artifact-read.ts";
import { McpResources, RESOURCE_CAPS } from "../../src/mcp/resources.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);

// Discovered once (not asserted as a golden fact, just picked): fn 188
// calls fn 190 directly (`kind: "closure"`), both own a real source range
// in module 5 — a stable enough pair for this bundle to exercise
// source/context/xref against real neighbours.
const CALLER_FN = 188;
const CALLEE_FN = 190;
const SHARED_SID = 69; // 'value' — used by both CALLER_FN and CALLEE_FN.

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-resources-"));
{
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
    // seed one tag revision directly against the DB (§2.2/§2.3) so
    // `history/{target}` has a real timeline to read before this file's own
    // `ProjectService` writes run (which now ALSO land in the DB — the
    // MCP-write-tools round's `ProjectService` DB write-path prerequisite).
    dbSetTag(db, `fn:${CALLEE_FN}`, "network", { source: "tool", who: "seed" });
  } finally {
    db.close();
  }
}

test.after(() => rmSync(outDir, { recursive: true, force: true }));

const res = new McpResources(outDir, { hbc: RN_TEMPLATE });

test("fn/{fn} returns the minimal summary preset", () => {
  const s = res.fn(CALLEE_FN);
  assert.equal(s.fn, CALLEE_FN);
  assert.equal(typeof s.name === "string" || s.name === null, true);
  assert.equal(typeof s.edgesOut, "number");
});

test("source/{fn} returns fn's own rendered text, capped like source", () => {
  const s = res.source(CALLEE_FN);
  assert.ok(s.text.length > 0);
  assert.equal(s.truncated, s.totalLines > RESOURCE_CAPS.sourceLines);
});

test("disasm/{fn} returns raw disassembly text, capped like source, never reusing source's own text", () => {
  const d = res.disasm(CALLEE_FN);
  const s = res.source(CALLEE_FN);
  assert.ok(d.text.length > 0);
  assert.notEqual(d.text, s.text);
  assert.equal(d.truncated, d.totalLines > RESOURCE_CAPS.sourceLines);
});

test("xref/who-calls inlines {fn, name, size} per neighbor (kills the N+1)", () => {
  const w = res.whoCalls(CALLEE_FN);
  assert.ok(w.rows.some((r) => r.fn === CALLER_FN), `fn ${CALLEE_FN} should be called by fn ${CALLER_FN}`);
  for (const row of w.rows) {
    assert.ok("fn" in row && "name" in row && "size" in row, "who-calls row must inline {fn, name, size}");
    if (typeof row.fn === "number") assert.equal(row.size === null || typeof row.size === "number", true);
  }
  assert.equal(typeof w.total, "number");
  assert.equal(typeof w.truncated, "boolean");
  assert.equal(typeof w.unknownInScope, "number");
});

test("xref/calls-from inlines neighbor metadata and reflects the discovered edge", () => {
  const c = res.callsFrom(CALLER_FN);
  assert.ok(c.rows.some((r) => r.fn === CALLEE_FN));
  for (const row of c.rows) assert.ok("name" in row && "size" in row);
});

test("xref/calls-from rows never exceed the published cap by default; truncated matches total", () => {
  const c = res.callsFrom(CALLER_FN);
  assert.ok(c.rows.length <= RESOURCE_CAPS.callsFrom);
  assert.equal(c.truncated, c.total > RESOURCE_CAPS.callsFrom);
});

test("xref/string mode=exact resolves a known sid", () => {
  const r = res.xrefString(SHARED_SID, "exact") as { value: { v?: string } | undefined; uses: { rows: unknown[]; total: number; truncated: boolean } };
  assert.ok(r.value !== undefined);
  assert.equal(typeof r.uses.total, "number");
});

test("xref/string mode=substring matches by literal substring, mode=regex by pattern", () => {
  const sub = res.xrefString("value", "substring") as unknown as { rows: { sid: number; head: string }[]; total: number; truncated: boolean };
  assert.ok(sub.rows.some((r) => r.sid === SHARED_SID));
  const rex = res.xrefString("^val", "regex") as unknown as { rows: { sid: number; head: string }[]; total: number; truncated: boolean };
  assert.ok(rex.rows.some((r) => r.sid === SHARED_SID));
});

test("xref/global-uses returns a bounded row set", () => {
  const g = res.globalUses("AbortController");
  assert.ok(g.rows.length >= 1);
  assert.ok(g.rows.length <= RESOURCE_CAPS.globalUses);
});

test("context/{fn} composes metadata+source+callers+callees+strings, never double-fetching source", () => {
  const ctx = res.context(CALLEE_FN);
  assert.ok(ctx.metadata !== undefined);
  assert.ok(ctx.source !== undefined);
  assert.ok(ctx.callers !== undefined);
  assert.ok(ctx.callees !== undefined);
  assert.ok(ctx.strings !== undefined);
  assert.ok(ctx.callers!.rows.some((r) => r.fn === CALLER_FN));
  assert.ok(ctx.strings!.rows.some((r) => r.sid === SHARED_SID));
  assert.equal(ctx.source!.text, res.source(CALLEE_FN).text, "context's source slice must be the SAME text source() returns, never re-derived");
});

test("context/{fn} honors include filter (no source key when omitted)", () => {
  const ctx = res.context(CALLEE_FN, { include: ["metadata", "callers"] });
  assert.ok(ctx.metadata !== undefined);
  assert.ok(ctx.callers !== undefined);
  assert.equal(ctx.source, undefined);
  assert.equal(ctx.callees, undefined);
  assert.equal(ctx.strings, undefined);
});

test("context/{fn} depth>1 walks further hops without duplicate fns", () => {
  const shallow = res.context(CALLER_FN, { include: ["callees"], depth: 1 });
  const deep = res.context(CALLER_FN, { include: ["callees"], depth: 2 });
  assert.ok(deep.callees!.rows.length >= shallow.callees!.rows.length);
  const fns = deep.callees!.rows.filter((r) => typeof r.fn === "number").map((r) => r.fn);
  assert.equal(fns.length, new Set(fns).size, "walked callees must be deduplicated");
});

test("module/{mod} returns direct edges only, a bounded shape, and owns the discovered fns", () => {
  const m = res.module(5);
  assert.equal(typeof m.ownedFnCount, "number");
  assert.ok(m.ownedFnCount >= 2);
  assert.ok(Array.isArray(m.deps));
  assert.ok(Array.isArray(m.dependents));
});

test("package-id/{mod} runs the real spec-13 identification (or returns an honest not-found)", async () => {
  const p = await res.packageId(5);
  assert.equal(typeof p.available, "boolean");
  if (p.available) {
    assert.equal(typeof p.package, "string");
    assert.ok(p.tier === "claim" || p.tier === "candidate");
  } else {
    assert.ok(p.reason.length > 0);
  }
});

test("native returns a bounded row set", () => {
  const n = res.native();
  assert.equal(typeof n.total, "number");
  assert.ok(n.rows.length <= RESOURCE_CAPS.native);
});

test("annotations/for-fn, findings, finding/{id} reflect an added finding without a JSONL round-trip", () => {
  res.project.addFinding({
    target: `fn:${CALLEE_FN}`,
    claim: "test claim for resources.test.ts",
    severity: "low",
    evidence: [{ ref: `fn:${CALLEE_FN}`, role: "primary" }],
    prov: { source: "tool", who: "resources.test.ts" },
  });
  const forFn = res.annotationsForFn(CALLEE_FN);
  assert.ok(forFn.rows.some((r) => r.type === "finding"));
  const all = res.findings({});
  const added = all.rows.find((r) => r.record.target === `fn:${CALLEE_FN}`);
  assert.ok(added !== undefined);
  const single = res.finding(added!.record.rid);
  assert.ok(single !== null);
  assert.equal(single!.record.claim, "test claim for resources.test.ts");
});

test("findings caps at its published bound with truncated marked honestly", () => {
  const f = res.findings({});
  assert.ok(f.rows.length <= RESOURCE_CAPS.findings);
  assert.equal(f.truncated, f.total > RESOURCE_CAPS.findings);
});

test("log[?since&who] reads the DB's append-only log table (init + rebuild-index rows)", () => {
  const l = res.log();
  assert.ok(l.rows.length >= 2, "init writes an 'init' row and a 'rebuild-index' row (spec 16 §4.1 step 4)");
  assert.ok(l.rows.some((r) => r.op === "init"));
  assert.ok(l.rows.some((r) => r.op === "rebuild-index"));
  assert.ok(l.rows.length <= RESOURCE_CAPS.log);
  assert.equal(l.truncated, l.total > RESOURCE_CAPS.log);
});

test("log[?who] filters by actor", () => {
  const seeded = res.log({ who: "seed" });
  assert.ok(seeded.rows.every((r) => r.who === "seed"));
  assert.ok(seeded.rows.some((r) => r.op === "annotate"));
});

test("history/{target} returns the seeded tag's revision timeline", () => {
  const h = res.history(`fn:${CALLEE_FN}`);
  // >= 1, not `=== 1`/`rows[0] is tag`: this project is DB-backed, so the
  // earlier "annotations/for-fn, findings, finding/{id}…" test's
  // `res.project.addFinding(...)` call now ALSO lands on this same target
  // (this round's `ProjectService` DB write-path prerequisite closed the
  // old "ProjectService's OWN write verbs still land in JSONL even for a
  // DB-backed project" gap this file used to note) — history is a superset
  // timeline across every record kind on the target, newest first, not
  // just the one this test itself seeded.
  assert.ok(h.rows.length >= 1);
  assert.ok(h.rows.some((r) => r.kind === "tag"));
  assert.ok(h.rows.length <= RESOURCE_CAPS.history);
});

test("history/{target} is empty for a target with no revisions", () => {
  const h = res.history("fn:0");
  assert.equal(h.rows.length, 0);
  assert.equal(h.total, 0);
});

test("annotated-calls inlines caller edges into the fn holding the seeded finding, one row per caller x finding", () => {
  const ac = res.annotatedCalls({});
  assert.ok(ac.rows.length >= 1);
  const row = ac.rows.find((r) => r.calleeFn === CALLEE_FN && r.caller.fn === CALLER_FN);
  assert.ok(row !== undefined);
  assert.equal(typeof row!.finding.rid, "string");
  assert.ok(ac.rows.length <= RESOURCE_CAPS.annotatedCalls);
});

test("annotated-calls[?status] filters to matching findings only", () => {
  const open = res.annotatedCalls({ status: "open" });
  const refuted = res.annotatedCalls({ status: "refuted" });
  assert.ok(open.rows.some((r) => r.calleeFn === CALLEE_FN));
  assert.equal(refuted.rows.length, 0);
});

test("log/history refuse cleanly against a directory with no project.hbcproj", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-resources-nodb-"));
  try {
    assert.throws(() => openProjectDbReadonly(emptyDir), /unable to open database file/i);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
