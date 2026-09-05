// ACCEPTANCE: spec 30 -- docs/specs/passes/30-finally-dedup.md section 7, rung
// `finally-dedup` (stage A, annotation-only, design B). Rung-owned properties
// only: how many `finally` clauses and how many copies of the finalizer body
// a named function prints, which sites refuse and under which code, and the
// annotation-only invariant. No whole-output comparison against a shared
// fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile, parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { structure, printTree } from "../../../src/structure/index.ts";
import { applyStagePasses } from "../../../src/structure/passes.ts";
import { blocksMultiset } from "../../../src/passes/tree.ts";
import { finallyDedup } from "../../../src/passes/finally-dedup/index.ts";
import { check } from "../../../src/passes/finally-dedup/check.ts";
import { match } from "../../../src/passes/finally-dedup/match.ts";
import { REGISTRY, enabledPasses } from "../../../src/passes/registry.ts";
import { repoRoot } from "../../support/paths.ts";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;
const bytes = (fixture: string, version: string): Buffer => readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`));
const run = (fixture: string, version: string, skip: readonly string[] = []): { code: string; diagnostics: readonly { code: string; message: string }[] } => {
  const r = decompile(bytes(fixture, version), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }) as Any;
  return { code: r.code as string, diagnostics: (r.diagnostics ?? []) as readonly { code: string; message: string }[] };
};
/** The text of one emitted function, by its `// fn#N "name"` marker. */
const fnText = (code: string, name: string): string => {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(`// fn#`) && l.includes(`"${name}"`));
  assert.ok(start >= 0, `no emitted function named ${name}`);
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = start + 1;
  while (end < lines.length && !(lines[end]!.trim() === "}" && lines[end]!.length - lines[end]!.trimStart().length === indent - 2)) end++;
  return lines.slice(start, end).join("\n");
};
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const FINALLY = /\} finally \{/g;
const refusals = (d: readonly { code: string; message: string }[]): string[] => d.filter((x) => x.code === "W_PASS_REFUSED" && x.message.includes("finally-dedup")).map((x) => x.message);

// ---------------------------------------------------------------------------
// Rung shape and ordering (spec 30 section 4).
// ---------------------------------------------------------------------------

test("finally-dedup is a stage-A rung on catalogue row 12, ordered before loop-cond, and try-shape now follows it", () => {
  assert.equal(finallyDedup.stage, "A");
  assert.deepEqual([...finallyDedup.catalogue], [12]);
  assert.ok((finallyDedup.before ?? []).includes("loop-cond"));
  const names = REGISTRY.map((p) => p.name);
  assert.ok(names.indexOf("finally-dedup") < names.indexOf("loop-cond"));
  assert.ok(names.indexOf("finally-dedup") < names.indexOf("try-shape"));
  assert.ok((REGISTRY.find((p) => p.name === "try-shape")?.after ?? []).includes("finally-dedup"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("finally-dedup: an already-annotated try is a fixed point without consulting the context (PL-08)", () => {
  const node = { k: "try", region: 0, cfgBlock: 3, body: { k: "block", cfgBlock: 1 }, handler: { k: "throw", cfgBlock: 2 }, catchRegister: 0, finalizer: { source: { cfgBlock: 2, from: 1, to: 2 }, copies: [], handlerIsRethrowOnly: true } };
  assert.equal(match(node as Any, {} as Any), null);
});

// ---------------------------------------------------------------------------
// Section 7 items 1-3: the two sites that fold.
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`spec 30 item 1: 13-try-finally-no-catch cleanup prints one finally and one push("cleanup") at ${version}`, () => {
    // The `// fn#N "cleanup"` marker line names the function, so it is dropped
    // before counting occurrences of the finalizer's own string literal (at
    // v96 the call prints as `r1 = r3.push(r1)`, so the literal, not the call,
    // is what identifies a copy at every version).
    const body = (t: string): string => t.split("\n").slice(1).join("\n");
    const fn = fnText(run("13-try-finally-no-catch", version).code, "cleanup");
    assert.equal(count(fn, FINALLY), 1, "exactly one finally clause");
    assert.equal(count(body(fn), /"cleanup"/g), 1, "the finalizer body is printed once (copy count 2 -> 1)");
    assert.equal(count(fn, /catch/g), 0, "the synthesized catch-and-rethrow is gone");
    // Without the rung the same function shows both copies and a catch.
    const before = fnText(run("13-try-finally-no-catch", version, ["finally-dedup"]).code, "cleanup");
    assert.equal(count(before, FINALLY), 0);
    assert.equal(count(body(before), /"cleanup"/g), 2);
  });

  test(`spec 30 item 2: 13-try-finally-no-catch risky has k = 1 and is refused at ${version}`, () => {
    const withRung = run("13-try-finally-no-catch", version);
    assert.equal(count(fnText(withRung.code, "risky"), FINALLY), 0, "nothing to merge: the try body ends in throw");
    assert.equal(fnText(withRung.code, "risky"), fnText(run("13-try-finally-no-catch", version, ["finally-dedup"]).code, "risky"));
    assert.ok(refusals(withRung.diagnostics).some((m) => m.includes("R-FD1")), "a named R-FD1 refusal is reported");
  });

  test(`spec 30 item 3: 12-try-catch-finally-return f2 prints one finally holding the return at ${version}`, () => {
    const code = run("12-try-catch-finally-return", version).code;
    const f2 = fnText(code, "f2");
    assert.equal(count(f2, FINALLY), 1);
    assert.match(f2, /\} finally \{\n\s+r\d+ = "finally-wins";\n\s+return r\d+;\n\s+\}/, "the finalizer's own transfer prints inside the finally (case B)");
    assert.equal(count(f2, /"finally-wins"/g), 1, "copy count 2 -> 1");
    // f1/f3 have no try at all at default -O (spec 30 section 9): untouched.
    for (const name of ["f1", "f3"]) {
      assert.equal(count(fnText(code, name), FINALLY), 0);
      assert.equal(fnText(code, name), fnText(run("12-try-catch-finally-return", version, ["finally-dedup"]).code, name));
    }
  });

  // -------------------------------------------------------------------------
  // Section 7 items 4-6: the refusals. Output identical to skipping the rung.
  // -------------------------------------------------------------------------

  test(`spec 30 item 4: 16-finally-with-break-continue is refused with a named code and prints unchanged at ${version}`, () => {
    const withRung = run("16-finally-with-break-continue", version);
    assert.equal(withRung.code, run("16-finally-with-break-continue", version, ["finally-dedup"]).code, "byte-identical to skipping the rung");
    assert.equal(count(withRung.code, FINALLY), 0);
    // MEASURED (spec 30 section 6, amended 2026-09-05): the code is version
    // dependent. At v84/v94/v96 the four sites are inside the dispatch nest
    // the structurer builds for the loop (R-FD5); at v98/v99 they are not, and
    // the four regions share one merge-point handler instead (R-FD3). Both are
    // refusals with a named code, which is what section 7 item 4 asks for.
    const want = version === "v98" || version === "v99" ? "R-FD3" : "R-FD5";
    const got = refusals(withRung.diagnostics);
    assert.ok(got.some((m) => m.includes(want)), `a named ${want} refusal is reported: ${got.join(" / ")}`);
    assert.ok(got.every((m) => /R-FD[1-8]/.test(m)), "every refusal carries a code from the table");
  });

  test(`spec 30 item 5: 54's applyWithGuard is refused R-FD3 at ${version}`, () => {
    const withRung = run("54-try-catch-finally-shared-range", version);
    assert.equal(count(fnText(withRung.code, "applyWithGuard"), FINALLY), 0, "the equal-range pair is not folded");
    assert.equal(fnText(withRung.code, "applyWithGuard"), fnText(run("54-try-catch-finally-shared-range", version, ["finally-dedup"]).code, "applyWithGuard"));
    assert.ok(refusals(withRung.diagnostics).some((m) => m.includes("R-FD3")), `a named R-FD3 refusal is reported: ${refusals(withRung.diagnostics).join(" / ")}`);
    // PUSHBACK P-50: spec 30 section 10 said no site in fixture 54 folds. Its
    // `nested` DOES fold its outer finally, soundly -- only the equal-range
    // pair `applyWithGuard` is the R-FD3 case the spec measured.
    assert.equal(count(fnText(withRung.code, "nested"), FINALLY), 1);
  });

  test(`spec 30 item 6: 100-irreducible-try-retry and 24-generator-return-throw are unchanged at ${version}`, () => {
    for (const fixture of ["100-irreducible-try-retry", "24-generator-return-throw"]) {
      const withRung = run(fixture, version);
      assert.equal(withRung.code, run(fixture, version, ["finally-dedup"]).code, `${fixture} byte-identical to skipping the rung`);
      assert.equal(count(withRung.code, FINALLY), 0);
    }
  });
}

// ---------------------------------------------------------------------------
// Section 7 item 7: annotation-only. Section 7 item 8: checker mutation.
// ---------------------------------------------------------------------------

const structuredOf = (fixture: string, version: string, fnIndex: number): Any => {
  const { module } = parseForDecompile(bytes(fixture, version), { resolveV98Ambiguity: true });
  const analysis = analyseModule(module, { strictEnv: false });
  const cfg = analysis.cfg(fnIndex);
  return { analysis, cfg, structured: structure(cfg, { verify: true }) };
};

for (const [fixture, fnIndex] of [["13-try-finally-no-catch", 2], ["12-try-catch-finally-return", 2]] as const) {
  for (const version of VERSIONS) {
    test(`spec 30 item 7: ${fixture} fn#${fnIndex} keeps its tree and block multiset at ${version}`, () => {
      const { analysis, cfg, structured: before } = structuredOf(fixture, version, fnIndex);
      const ctx = { analysis, functionIndex: fnIndex, cfg, hbcVersion: 0, layoutClass: "B", applied: [], diagnostic: () => {}, structured: before } as Any;
      const after = applyStagePasses(before, [finallyDedup as Any], ctx) as Any;
      const tree = (t: string): string => t.replace(/ finalizer=\S+ copies=\[[^\]]*\]/g, "");
      const afterTree = printTree({ ...before, root: after.result });
      assert.match(afterTree, /finalizer=/, "the annotation is written");
      assert.equal(tree(afterTree), printTree(before), "nothing but the annotation changed");
      const blocks = (t: Any): string => JSON.stringify([...blocksMultiset(t.root)].sort());
      assert.equal(blocks({ root: after.result }), blocks(before));
    });
  }
}

test("spec 30 item 8: the checker rejects a source range widened by one instruction", () => {
  const { analysis, cfg, structured } = structuredOf("13-try-finally-no-catch", "v84", 2);
  const ctx = { analysis, functionIndex: 2, cfg, hbcVersion: 84, layoutClass: "B", applied: [], diagnostic: () => {}, structured } as Any;
  const findTry = (n: Any): Any => (n.k === "try" ? n : [n.body, n.handler, n.then, n.else, ...(n.body?.length !== undefined ? n.body : [])].filter(Boolean).map(findTry).find(Boolean));
  const node = findTry(structured.root);
  assert.ok(node !== undefined, "fixture 13's cleanup has a try node");
  const m = match(node, ctx);
  assert.ok(m !== null, "the site matches");
  assert.equal(check(node, { ...node, finalizer: m.data }, ctx).ok, true, "the honest annotation passes");
  const widened = { ...m.data, source: { ...m.data.source, to: m.data.source.to + 1 } };
  assert.equal(check(node, { ...node, finalizer: widened }, ctx).ok, false, "a widened source range is rejected");
  const movedCopy = { ...m.data, copies: [{ ...m.data.copies[0], from: m.data.copies[0].from + 1, to: m.data.copies[0].to + 1 }] };
  assert.equal(check(node, { ...node, finalizer: movedCopy }, ctx).ok, false, "a shifted copy range is rejected");
  assert.equal(check(node, { ...node, finalizer: { ...m.data, copies: [] } }, ctx).ok, false, "an empty copy list is rejected");
});
