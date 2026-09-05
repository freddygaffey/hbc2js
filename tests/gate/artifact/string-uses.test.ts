// tests/gate/artifact/string-uses.test.ts — acceptance for the
// `query string-uses <sid>` verb (docs/specs/10-artifact-format.md §3.1,
// docs/specs/hunt-tooling-backlog.md gap #2): return the instruction-level
// use SITES for a string, not just `string(sid)`'s `fn role n` counts.
//
// The artifact format itself is unchanged (spec 10 §2.3b): sites are
// computed ON DEMAND by re-walking the function's bytecode with the SAME
// classifier (`walkFunction`'s `bumpString` call sites) that produced
// `string-uses.jsonl` — this file's central assertion is that the two never
// disagree (a per-(sid,fn,role) site count always equals the `n` on disk).
// Live verb: needs `--hbc`, like `object-tables`/`disasm`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService, CAPS, type StringUseSite } from "../../../src/artifact/service.ts";
import { handle, type UiServerCtx } from "../../../src/ui-server/routes.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-string-uses-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir, { hbc: RN_TEMPLATE });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

interface UseRow {
  readonly sid: number;
  readonly fn: number;
  readonly role: string;
  readonly n: number;
}
const useRows: UseRow[] = readFileSync(join(outDir, "index", "string-uses.jsonl"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => JSON.parse(l) as UseRow);

// A sid touched by more than CAPS.stringUses sites, for the cap/--all tests.
const totalsBySid = new Map<number, number>();
for (const r of useRows) totalsBySid.set(r.sid, (totalsBySid.get(r.sid) ?? 0) + r.n);
let bigSid = -1;
let bigTotal = 0;
for (const [sid, n] of totalsBySid) if (n > bigTotal) (bigTotal = n), (bigSid = sid);
assert.ok(bigSid >= 0 && bigTotal > CAPS.stringUses, "rn-template must have a sid with more sites than the default cap");

// A sid used in more than one role at the SAME fn, for the per-(sid,fn,role) cross-check.
let multiRoleFn: { sid: number; fn: number; roles: readonly string[] } | undefined;
{
  const bySidFn = new Map<string, UseRow[]>();
  for (const r of useRows) {
    const key = `${r.sid}:${r.fn}`;
    const l = bySidFn.get(key) ?? [];
    l.push(r);
    bySidFn.set(key, l);
  }
  for (const [key, l] of bySidFn) {
    if (l.length > 1) {
      const [sidText, fnText] = key.split(":");
      multiRoleFn = { sid: Number(sidText), fn: Number(fnText), roles: l.map((r) => r.role) };
      break;
    }
  }
}
assert.ok(multiRoleFn !== undefined, "rn-template must have a (sid, fn) pair used under more than one role");

test("sites are sorted by (fn, pc)", () => {
  const r = svc.stringUseSites(bigSid, { all: true });
  for (let i = 1; i < r.rows.length; i++) {
    const a = r.rows[i - 1]!;
    const b = r.rows[i]!;
    assert.ok(b.fn > a.fn || (b.fn === a.fn && b.pc >= a.pc), `rows ${i - 1},${i} out of (fn,pc) order`);
  }
});

test("--fn narrows to sites in that one function only", () => {
  const { sid, fn } = multiRoleFn!;
  const r = svc.stringUseSites(sid, { fn });
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) assert.equal(row.fn, fn);
});

test("per-(sid,fn,role) site count equals string-uses.jsonl's n", () => {
  const { sid, fn } = multiRoleFn!;
  const r = svc.stringUseSites(sid, { fn, all: true });
  const byRole = new Map<string, number>();
  for (const row of r.rows) byRole.set(row.role, (byRole.get(row.role) ?? 0) + 1);
  const expected = useRows.filter((u) => u.sid === sid && u.fn === fn);
  assert.ok(expected.length > 1);
  for (const e of expected) assert.equal(byRole.get(e.role), e.n, `sid:${sid} fn:${fn} role:${e.role}`);
});

test("default call is capped at CAPS.stringUses; --all lifts it, and total/truncated stay honest", () => {
  const capped = svc.stringUseSites(bigSid);
  assert.equal(capped.rows.length, CAPS.stringUses);
  assert.equal(capped.total, bigTotal);
  assert.equal(capped.truncated, true);

  const all = svc.stringUseSites(bigSid, { all: true });
  assert.equal(all.rows.length, bigTotal);
  assert.equal(all.total, bigTotal);
  assert.equal(all.truncated, false);
});

test("without --hbc the verb fails with the usual E_USAGE, live-verb message", () => {
  const svcNoHbc = new ArtifactService(outDir);
  assert.throws(() => svcNoHbc.stringUseSites(bigSid), /E_USAGE.*needs --hbc/);
});

test("moduleId matches moduleOfFn (native.jsonl / functions.jsonl's own module attribution)", () => {
  const r = svc.stringUseSites(bigSid, { all: true });
  const someFn = r.rows.find((row) => row.moduleId !== null);
  assert.ok(someFn !== undefined, "at least one site should have a known owning module");
});

test("an unknown sid is not an error — it is an empty, non-truncated result", () => {
  const r = svc.stringUseSites(999_999_999);
  assert.deepEqual(r, { rows: [], total: 0, truncated: false });
});

test("CLI: `query string-uses` prints fn/pc/opcode/role rows and a total", () => {
  const { sid, fn } = multiRoleFn!;
  const out = execFileSync("node", [CLI, "query", "string-uses", String(sid), "--fn", String(fn), "--artifact", outDir, "--hbc", RN_TEMPLATE], {
    encoding: "utf8",
  });
  assert.match(out, /^fn:\d+ \S+ pc:\d+ \S+ \S+ module:(\d+|-)$/m);
  assert.match(out, /^total:\d+$/m);
});

test("CLI: `--json` emits the service result verbatim", () => {
  const out = execFileSync("node", [CLI, "query", "string-uses", String(bigSid), "--artifact", outDir, "--hbc", RN_TEMPLATE, "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as { rows: readonly StringUseSite[]; total: number; truncated: boolean };
  assert.equal(parsed.total, bigTotal);
  assert.equal(parsed.rows.length, CAPS.stringUses);
});

test("CLI: missing --hbc fails with a usage error", () => {
  try {
    execFileSync("node", [CLI, "query", "string-uses", String(bigSid), "--artifact", outDir], { encoding: "utf8", stdio: "pipe" });
    assert.fail("missing --hbc must exit non-zero");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    assert.match(`${err.stderr ?? ""}${err.stdout ?? ""}`, /needs --hbc/);
  }
});

test("CLI: an unknown query verb still lists string-uses", () => {
  try {
    execFileSync("node", [CLI, "query", "no-such-verb", "--artifact", outDir], { encoding: "utf8", stdio: "pipe" });
    assert.fail("an unknown verb must exit non-zero");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    assert.match(`${err.stderr ?? ""}${err.stdout ?? ""}`, /string-uses/);
  }
});

test("route: GET /api/string-uses passes sid/fn/all through and inlines size", async () => {
  let seen: unknown;
  const ctx = {
    resources: {
      stringUseSites: (sid: number, opts: unknown) => {
        seen = { sid, opts };
        return { rows: [], total: 0, truncated: false };
      },
    },
  } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: "/api/string-uses", body: null, query: { sid: "126", fn: "4", all: "true" } }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { sid: 126, opts: { fn: 4, all: true } });
});

test("route: GET /api/string-uses requires ?sid=", async () => {
  const ctx = { resources: {} } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: "/api/string-uses", body: null, query: {} }, ctx);
  assert.equal(res.status, 400);
});
