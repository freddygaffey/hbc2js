// tests/ui-server/sandbox.test.ts — docs/specs/26-ui-full-ide.md L8's named
// acceptance tests for `src/ui-server/sandbox.ts` (spec 21 §2.1/§2.4, spec
// 23 §7). Same fixture recipe as `routes.test.ts` (rn-template-0.72 through
// the real split + project DB), and the same rule: no literal-string
// comparison against a shared fixture's decompiled output.
//
// TOOLCHAIN INDEPENDENCE. `McpTools.recompileEdit` needs `tools/hermesc/vNN`
// for the bundle's version, which not every machine has. Every test here is
// written so it asserts the SANDBOX's contract either way: the ones that need
// a successful recompile detect the toolchain and assert the "no hermesc"
// refusal path instead of skipping silently (the sandbox must be torn down
// on that path too — that IS the "when the recompile throws" case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import { createSandbox, destroySandbox, liveSandboxPaths, refusalForProvenance, withSandbox } from "../../src/ui-server/sandbox.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const EDIT_FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-sandbox-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

const outDir = buildFixture();
test.after(() => rmSync(outDir, { recursive: true, force: true }));

const mcpContext = new McpContext(outDir, { hbc: RN_TEMPLATE });
const ctx: UiServerCtx = { resources: mcpContext.resources, tools: mcpContext.tools, artifactDir: outDir };
const human = { source: "human" as const, who: "analyst@duck.com" };
const GOOD_SOURCE = "function patched(a, b) { return a + b; }\nprint(patched(1, 2));\n";
const BROKEN_SOURCE = "function ( { this is not javascript ===\n";

function post(path: string, body: unknown) {
  return handle({ method: "POST", path, query: {}, body }, ctx);
}
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const projectDb = join(outDir, "project.hbcproj");

test("a sandbox is torn down on success", async () => {
  let seen = "";
  const { value, sandbox } = await withSandbox({ kind: "copy" }, (sb) => {
    seen = sb.path;
    // A real experiment writes into it; teardown must take the writes too.
    writeFileSync(join(sb.path, "edit.js"), GOOD_SOURCE);
    assert.ok(existsSync(join(sb.path, "edit.js")), "the sandbox must be usable while the experiment runs");
    assert.deepEqual(liveSandboxPaths(), [sb.path]);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(sandbox.tornDown, true);
  assert.equal(sandbox.kind, "copy");
  assert.ok(sandbox.id.length > 0);
  assert.equal(existsSync(seen), false, "the sandbox directory must not survive the experiment");
  assert.deepEqual(liveSandboxPaths(), []);
});

test("a sandbox is torn down when the recompile throws", async () => {
  // (a) the primitive: any throw inside the experiment still tears down.
  let seen = "";
  await assert.rejects(
    withSandbox({ kind: "copy" }, (sb) => {
      seen = sb.path;
      writeFileSync(join(sb.path, "edit.js"), BROKEN_SOURCE);
      throw new Error("hermesc said no");
    }),
    /hermesc said no/,
  );
  assert.equal(existsSync(seen), false);
  assert.deepEqual(liveSandboxPaths(), []);

  // (b) the route: a source hermesc cannot compile (or a missing hermesc)
  // is a 400 whose reason is the tool's own, and leaves nothing behind.
  const r = await post("/api/tools/recompile-edit", { fn: EDIT_FN, source: BROKEN_SOURCE, prov: human });
  assert.equal(r.status, 400);
  assert.match((r.json as { reason: string }).reason, /recompile_edit/);
  assert.deepEqual(liveSandboxPaths(), [], "a failed experiment must leak no sandbox");
});

test("the original bundle and .hbcproj are byte-identical after an experiment", async () => {
  const bundleBefore = sha(RN_TEMPLATE);
  const dbBefore = sha(projectDb);

  // A sandbox experiment on its own touches neither, whatever it writes.
  await withSandbox({ kind: "copy" }, (sb) => writeFileSync(join(sb.path, "index.android.hbc"), Buffer.concat([bytes, Buffer.from([0])])));
  assert.equal(sha(RN_TEMPLATE), bundleBefore);
  assert.equal(sha(projectDb), dbBefore);

  // A failed recompile through the route likewise.
  await post("/api/tools/recompile-edit", { fn: EDIT_FN, source: BROKEN_SOURCE, prov: human });
  assert.equal(sha(RN_TEMPLATE), bundleBefore);
  assert.equal(sha(projectDb), dbBefore);

  // A SUCCESSFUL recompile leaves the bundle byte-identical too; the
  // `.hbcproj` gains exactly one row, and only through the sanctioned
  // logged-write path (`McpTools.recompileEdit`'s own `addComment`, its
  // NO-MUTATE PROOF) — never a second, weaker path around ProjectService.
  const logBefore = mcpContext.resources.project.log({}, { all: true }).rows.length;
  const r = await post("/api/tools/recompile-edit", { fn: EDIT_FN, source: GOOD_SOURCE, prov: human });
  assert.equal(sha(RN_TEMPLATE), bundleBefore, "the bundle is never written, with or without a toolchain");
  if (r.status === 200) {
    const body = r.json as { warning: string; watermark: { kind: string }; outputPath: string; sandbox: { tornDown: boolean } };
    assert.equal(body.watermark.kind, "edited-and-recompiled");
    assert.equal(body.sandbox.tornDown, true);
    assert.ok(!body.outputPath.startsWith(outDir), "the recompiled copy never lands inside the project");
    assert.equal(mcpContext.resources.project.log({}, { all: true }).rows.length, logBefore + 1);
  } else {
    // No hermesc for this bundle version on this machine: the tool refuses
    // and the project is then byte-identical as well.
    assert.equal(r.status, 400);
    assert.equal(sha(projectDb), dbBefore);
  }
  assert.deepEqual(liveSandboxPaths(), []);
});

test("two concurrent experiments never share a sandbox path", async () => {
  const paths: string[] = [];
  const release: Array<() => void> = [];
  const gate = new Promise<void>((resolve) => release.push(resolve));
  const runs = Array.from({ length: 16 }, () =>
    withSandbox({ kind: "copy" }, async (sb) => {
      paths.push(sb.path);
      await gate; // every sandbox is alive at the same time
      return sb.path;
    }),
  );
  // All 16 exist simultaneously and are distinct.
  while (paths.length < 16) await new Promise((res) => setTimeout(res, 5));
  assert.equal(new Set(paths).size, 16, "two experiments must never be handed the same path");
  assert.equal(new Set(liveSandboxPaths()).size, 16);
  for (const p of paths) assert.equal(existsSync(p), true);
  release[0]!();
  await Promise.all(runs);
  for (const p of paths) assert.equal(existsSync(p), false);
  assert.deepEqual(liveSandboxPaths(), []);
});

test("a worker-initiated recompile-edit is refused", async () => {
  const logBefore = mcpContext.resources.project.log({}, { all: true }).rows.length;
  for (const prov of [
    { source: "llm", who: "worker:poc-finding" },
    { source: "tool", who: "worker:explain-fn" },
    { source: "llm", who: "some-agent" },
  ]) {
    const r = await post("/api/tools/recompile-edit", { fn: EDIT_FN, source: GOOD_SOURCE, prov });
    assert.equal(r.status, 403, `worker provenance ${JSON.stringify(prov)} must be refused`);
    assert.match((r.json as { reason: string }).reason, /attended-only/);
  }
  // Refused BEFORE anything ran: no sandbox, no log row, no binary.
  assert.deepEqual(liveSandboxPaths(), []);
  assert.equal(mcpContext.resources.project.log({}, { all: true }).rows.length, logBefore);
  assert.equal(refusalForProvenance(human), null, "an attended human write is not refused");
});

test("a worktree sandbox is git-native and leaves no worktree registration behind", () => {
  // The other half of spec 21 §2.4's "worktree OR temp copy": exercised
  // against this repo's own checkout, skipped when the tests run from a
  // tarball rather than a git clone.
  if (!existsSync(join(repoRoot(), ".git"))) return;
  const sb = createSandbox({ kind: "worktree", repoRoot: repoRoot() });
  try {
    assert.equal(sb.kind, "worktree");
    assert.ok(existsSync(join(sb.path, "package.json")), "a worktree sandbox is a real checkout");
  } finally {
    const report = destroySandbox(sb);
    assert.equal(report.tornDown, true);
  }
  assert.equal(existsSync(sb.path), false);
  assert.deepEqual(liveSandboxPaths(), []);
});
