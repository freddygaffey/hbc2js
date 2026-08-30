// D12a: "a pass may import only src/passes/framework and src/structure's
// public IR/verifier types — never src/emit, src/cfg, or another pass."
// Enforced here, because the whole point of D12a is that a pass can be written
// and reviewed by someone who has read `src/passes/README.md` and one spec, and
// that stops being true the moment a pass reaches into the emitter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { REGISTRY } from "../../../src/passes/registry.ts";

const passesDir = join(repoRoot(), "src", "passes");

/** The framework surface a pass module is allowed to reach for. */
const ALLOWED = new Set(["../types.ts", "../tree.ts", "../driver.ts", "../../structure/ir.ts", "../../structure/verify.ts"]);

/** `import … from "x"` / `export … from "x"`, static and dynamic. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

function passDirs(): string[] {
  return readdirSync(passesDir)
    .filter((e) => statSync(join(passesDir, e)).isDirectory())
    .sort();
}

test("D12a: every registered pass is a directory under src/passes, and vice versa", () => {
  assert.deepEqual(passDirs(), [...REGISTRY.map((p) => p.name)].sort());
  for (const p of REGISTRY) {
    for (const f of ["index.ts", "match.ts", "rewrite.ts", "check.ts"]) {
      assert.ok(statSync(join(passesDir, p.name, f)).isFile(), `${p.name}/${f} is missing`);
    }
  }
});

test("D12a import boundary: a pass reaches only the framework and src/structure's public IR", () => {
  const violations: string[] = [];
  for (const dir of passDirs()) {
    for (const file of readdirSync(join(passesDir, dir)).filter((f) => f.endsWith(".ts"))) {
      const rel = `${dir}/${file}`;
      for (const spec of importsOf(readFileSync(join(passesDir, dir, file), "utf8"))) {
        if (spec.startsWith("node:")) continue;
        if (spec.startsWith("./")) continue; // a sibling inside the same pass
        if (ALLOWED.has(spec)) continue;
        violations.push(`${rel} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `a pass may import only ${[...ALLOWED].join(", ")} plus its own siblings — put anything else in src/passes/tree.ts`);
});

test("D12a: src/passes/README.md is the one page an implementer reads", () => {
  const readme = readFileSync(join(passesDir, "README.md"), "utf8");
  for (const needle of ["match", "rewrite", "check", "catalogue", "--passes=none", "E_PASS_CRASH"]) {
    assert.ok(readme.includes(needle), `README.md does not document ${needle}`);
  }
  // The boundary is only enforceable if the page states it.
  for (const spec of ALLOWED) assert.ok(readme.includes(spec.replace(/^\.\.\//, "")), `README.md does not name ${spec}`);
});
