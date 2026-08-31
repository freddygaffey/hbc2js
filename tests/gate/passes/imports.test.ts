// D12a: "a pass may import only src/passes/framework and src/structure's
// public IR/verifier types — never src/emit, src/cfg, or another pass."
// Enforced here, because the whole point of D12a is that a pass can be written
// and reviewed by someone who has read `src/passes/README.md` and one spec, and
// that stops being true the moment a pass reaches into the emitter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { REGISTRY } from "../../../src/passes/registry.ts";
// Passes intentionally unregistered (code kept) — see docs/BUGS.md.
const DISABLED_PASSES = new Set<string>([]);

const passesDir = join(repoRoot(), "src", "passes");

/** The framework surface a pass module is allowed to reach for. F8 adds
 *  `../ast.ts` (the stage-B counterpart to `../tree.ts`). */
const ALLOWED = new Set(["../types.ts", "../tree.ts", "../ast.ts", "../driver.ts", "../../structure/ir.ts", "../../structure/verify.ts"]);

/**
 * `import … from "x"` / `export … from "x"`, static and dynamic, **and** a
 * clause-less side-effect `import "x";` (review M5-pass-1 F1: the original
 * regex required a `from` clause, so `import "../../emit/conds.ts";` was
 * invisible to it).
 */
function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/**
 * A relative specifier is a genuine sibling only if it *resolves* inside
 * `dirAbs` — review M5-pass-1 F1: the original check was
 * `spec.startsWith("./")`, which treats any `./`-prefixed specifier as a
 * sibling, so one extra `./` (`"./../../emit/conds.ts"`) walked straight out
 * of the pass directory undetected.
 */
function isSibling(dirAbs: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false;
  const abs = resolve(dirAbs, spec);
  return abs === dirAbs || abs.startsWith(dirAbs + sep);
}

/** The boundary violations in `source`, a file that would live at `dirAbs`. */
function violationsIn(dirAbs: string, source: string): string[] {
  const out: string[] = [];
  for (const spec of importsOf(source)) {
    if (spec.startsWith("node:")) continue;
    if (isSibling(dirAbs, spec)) continue;
    if (ALLOWED.has(spec)) continue;
    out.push(spec);
  }
  return out;
}

function passDirs(): string[] {
  return readdirSync(passesDir)
    .filter((e) => statSync(join(passesDir, e)).isDirectory())
    .sort();
}

test("D12a: every registered pass is a directory under src/passes, and vice versa", () => {
  assert.deepEqual(passDirs().filter((d) => !DISABLED_PASSES.has(d)), [...REGISTRY.map((p) => p.name)].sort());
  for (const p of REGISTRY) {
    for (const f of ["index.ts", "match.ts", "rewrite.ts", "check.ts"]) {
      assert.ok(statSync(join(passesDir, p.name, f)).isFile(), `${p.name}/${f} is missing`);
    }
    // review M5-pass-1 F8 / D12a (docs/DECISIONS.md): every pass has its own
    // tests/gate/passes/<name>.test.ts — neither shipped pass had one before
    // for-header's landed alongside this fix.
    assert.ok(statSync(join(repoRoot(), "tests", "gate", "passes", `${p.name}.test.ts`)).isFile(), `tests/gate/passes/${p.name}.test.ts is missing`);
  }
});

test("D12a import boundary: a pass reaches only the framework and src/structure's public IR", () => {
  const violations: string[] = [];
  for (const dir of passDirs()) {
    const dirAbs = join(passesDir, dir);
    for (const file of readdirSync(dirAbs).filter((f) => f.endsWith(".ts"))) {
      for (const spec of violationsIn(dirAbs, readFileSync(join(dirAbs, file), "utf8"))) violations.push(`${dir}/${file} imports ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `a pass may import only ${[...ALLOWED].join(", ")} plus its own siblings — put anything else in src/passes/tree.ts or src/passes/ast.ts`);
});

// review M5-pass-1 F1: the boundary check must catch every one of these five
// forms over an in-memory source string, not merely the two well-behaved
// passes that happen to exist today.
test("D12a import boundary: five forbidden-import forms, and the two sibling/allowed forms that must still pass", () => {
  const dirAbs = join(passesDir, "loop-cond");
  const forbidden: readonly string[] = [
    'import { conditionFor } from "../../emit/conds.ts";',
    'export { conditionFor } from "../../emit/conds.ts";',
    'import { forHeader } from "../for-header/index.ts";',
    'import "../../emit/conds.ts";', // clause-less side-effect import
    'import { conditionFor } from "./../../emit/conds.ts";', // one extra "./" walks out
  ];
  for (const source of forbidden) assert.notDeepEqual(violationsIn(dirAbs, source), [], `should have flagged: ${source}`);

  const allowed: readonly string[] = ['import { match } from "./match.ts";', 'import type { Stmt } from "../../structure/ir.ts";', 'import type { Pass } from "../types.ts";', 'import { items } from "../tree.ts";'];
  for (const source of allowed) assert.deepEqual(violationsIn(dirAbs, source), [], `should not have flagged: ${source}`);
});

test("D12a: src/passes/README.md is the one page an implementer reads", () => {
  const readme = readFileSync(join(passesDir, "README.md"), "utf8");
  for (const needle of ["match", "rewrite", "check", "catalogue", "--passes=none", "E_PASS_CRASH"]) {
    assert.ok(readme.includes(needle), `README.md does not document ${needle}`);
  }
  // The boundary is only enforceable if the page states it.
  for (const spec of ALLOWED) assert.ok(readme.includes(spec.replace(/^\.\.\//, "")), `README.md does not name ${spec}`);
});
