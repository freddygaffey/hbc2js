// review-M4-C1 — exception regions with *identical* byte ranges were nested in
// inverted priority.
//
// A `try` that has BOTH a `catch` and a `finally` compiles to two handler-table
// entries with the same `[start, end)`: the catch first, the finally's
// catch-and-rethrow half second. `src/cfg/exceptions.ts` used to break the sort
// tie by file order ascending and to refuse an equal-range region a parent, so
// the two became siblings and the structurer made the *earlier* entry the
// *outer* JS `try`. The Hermes VM does the opposite: `findCatchTargetOffset`
// returns the FIRST matching table entry, so for equal ranges the earlier entry
// is the INNER handler. The decompiled code therefore skipped the `catch` and
// sent the exception to the `finally`'s rethrow.
//
// React Native's own `ErrorUtils.applyWithGuard` is exactly this shape, so the
// third test compiles the polyfill *verbatim out of the shipped rn-template
// bundle* and runs it through the trace oracle against the Hermes VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { requireHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireHermesVm } from "../../support/hermesvm.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import type { ExceptionRegion } from "../../../src/cfg/types.ts";
import { decompile } from "../../../src/decompile.ts";
import { runProgram } from "../../../src/harness/runner.ts";
import { runHermes } from "../../../src/harness/hermes-vm.ts";
import { printLines } from "../../../src/harness/trace.ts";

const FIXTURE = "54-try-catch-finally-shared-range";
const VERSIONS = [84, 94, 96, 98, 99] as const;

function constructPath(version: number): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${version}.hbc`);
}

function key(r: { startPc: number; endPc: number }): string {
  return `${r.startPc}..${r.endPc}`;
}

/** Walk `parent` up to the root. */
function isAncestor(regions: readonly ExceptionRegion[], ancestor: number, of: number): boolean {
  let p = regions[of]!.parent;
  while (p !== null) {
    if (p === ancestor) return true;
    p = regions[p]!.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. The CFG invariant: equal ranges never become siblings, and the region
//    matching the *earlier* handler-table entry is the inner one.
// ---------------------------------------------------------------------------

test("review-M4-C1: equal-range exception regions nest, earliest table entry innermost", () => {
  let equalRangePairs = 0;
  for (const version of VERSIONS) {
    const { module } = parseM4(new Uint8Array(readFileSync(constructPath(version))));
    const analysis = analyseModule(module, { strictEnv: true });
    for (let fi = 0; fi < module.functions.length; fi++) {
      const handlers = module.functions[fi]!.exceptionHandlers;
      if (handlers.length < 2) continue;
      const { regions } = analysis.cfg(fi);
      const byRange = new Map<string, ExceptionRegion[]>();
      for (const r of regions) {
        const g = byRange.get(key(r));
        if (g === undefined) byRange.set(key(r), [r]);
        else g.push(r);
      }
      for (const group of byRange.values()) {
        if (group.length < 2) continue;
        equalRangePairs++;
        // (a) they are a chain, never siblings — every one but the outermost
        //     has a parent inside the group.
        const rooted = group.filter((r) => !group.some((o) => o !== r && isAncestor(regions, o.index, r.index)));
        assert.equal(rooted.length, 1, `regions ${group.map((r) => r.index).join(",")} of fn#${fi} v${version} share range ${key(group[0]!)} but do not form a single nesting chain`);
        // (b) direction: the handler that comes FIRST in the file's table is
        //     the INNERMOST region, because that is the one the VM's
        //     first-match `findCatchTargetOffset` selects.
        const fileOrderOf = (r: ExceptionRegion): number =>
          handlers.findIndex((h) => h.start === r.startPc && h.end === r.endPc && analysis.cfg(fi).blocks[r.handlerBlock]!.start === h.target);
        const sortedByDepth = [...group].sort((a, b) => (isAncestor(regions, a.index, b.index) ? -1 : 1));
        const orders = sortedByDepth.map(fileOrderOf);
        assert.ok(
          orders.every((o) => o >= 0),
          `fn#${fi} v${version}: a region does not correspond to any handler-table entry`,
        );
        // outermost first => file order must be DESCENDING.
        for (let i = 1; i < orders.length; i++) {
          assert.ok(orders[i]! < orders[i - 1]!, `fn#${fi} v${version}: equal-range regions nest in table order ${orders.join(",")}; the VM takes the first matching entry, so the inner one must be the earlier entry`);
        }
      }
    }
  }
  assert.ok(equalRangePairs > 0, `${FIXTURE} no longer contains an equal-range handler pair — the regression test has lost its subject`);
});

// ---------------------------------------------------------------------------
// 2. Behaviour: the fixture's decompiled output reaches the `catch`.
// ---------------------------------------------------------------------------

test("review-M4-C1: the shared-range fixture's catch is entered, not the finally rethrow", async () => {
  const expected = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, "expected.txt"), "utf8").trimEnd();
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-c1-"));
  try {
    for (const version of VERSIONS) {
      const code = decompile(new Uint8Array(readFileSync(constructPath(version))), { resolveV98Ambiguity: true, moduleName: FIXTURE }).code;
      const file = join(dir, `v${version}.js`);
      writeFileSync(file, code);
      const result = await runProgram(file, { timeout: 20000 });
      const lines = printLines(result.records).join("\n").trimEnd();
      assert.equal(lines, expected, `v${version}: decompiled output diverges from the fixture's expected trace`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The real thing: React Native's `ErrorUtils` polyfill, lifted verbatim out
//    of tests/fixtures/bundles/rn-template-0.72/index.android.bundle (the
//    source the committed index.android.hbc was compiled from — fn#66
//    `applyWithGuard` is one of its six equal-range functions), compiled with
//    hermesc and compared against the Hermes VM's own execution.
// ---------------------------------------------------------------------------

/** The `ErrorUtils` IIFE, exactly as the shipped bundle spells it. */
function errorUtilsPolyfill(): string {
  const bundle = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.bundle"), "utf8");
  const start = bundle.indexOf("applyWithGuard:function");
  assert.ok(start > 0, "index.android.bundle no longer contains ErrorUtils.applyWithGuard");
  const open = bundle.lastIndexOf("!(function(", start);
  const end = bundle.indexOf("\n", start);
  assert.ok(open > 0 && end > open, "could not delimit the ErrorUtils IIFE in index.android.bundle");
  const src = bundle.slice(open, end);
  assert.ok(src.includes("try{return r++,n.apply(t,u)}catch(n){l.reportError(n)}finally{r--}"), "the shipped applyWithGuard is no longer the try/catch/finally shape this test exists for");
  return src;
}

const DRIVER = `
var order = [];
ErrorUtils.setGlobalHandler(function (e, fatal) { order.push('handler ' + e.message + ' fatal=' + fatal); });
print('inGuard before:', ErrorUtils.inGuard());
print('ok:', ErrorUtils.applyWithGuard(function (a, b) { order.push('during=' + ErrorUtils.inGuard()); return a + b; }, null, [2, 3]));
print('throw:', ErrorUtils.applyWithGuard(function () { throw new Error('boom'); }, null, []));
print('inGuard after:', ErrorUtils.inGuard());
print('order:', order.join(' | '));
`;

test("review-M4-C1: rn-template's ErrorUtils.applyWithGuard matches the Hermes VM", async (t) => {
  const hermesc = requireHermesc(t, 94);
  if (hermesc === null) return;
  const vm = requireHermesVm(t, 94);
  if (vm === null) return;

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-c1-rn-"));
  try {
    writeFileSync(join(dir, "source.js"), errorUtilsPolyfill() + DRIVER);
    const compiled = runHermesc(hermesc, ["-emit-binary", "-out=source.hbc", "source.js"], dir);
    assert.equal(compiled.status, 0, `hermesc failed: ${compiled.stderr}`);

    const hbcPath = join(dir, "source.hbc");
    const candidatePath = join(dir, "candidate.js");
    writeFileSync(candidatePath, decompile(new Uint8Array(readFileSync(hbcPath)), { moduleName: "rn-error-utils" }).code);

    // §3.2: the bare VM has no injectable prelude, so the trace is the
    // print-channel projection on both sides — exactly what `equiv --hbc` uses.
    const reference = runHermes(vm.path, hbcPath, { timeout: 20000, bytecode: true });
    assert.ok(reference.ok, `Hermes VM run failed: ${reference.raw}`);
    // The guard works in the VM: the throw is reported, not escaped.
    assert.ok(reference.lines.includes("order: during=true | handler boom fatal=false"), `the VM's own run of the polyfill did not reach reportError — the driver is wrong, not the decompiler:\n${reference.raw}`);

    const candidate = await runProgram(candidatePath, { timeout: 20000 });
    assert.deepEqual(printLines(candidate.records), reference.lines, "the decompiled ErrorUtils diverges from the Hermes VM's own run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
