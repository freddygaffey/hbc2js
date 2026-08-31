// Per-function error isolation (docs/BUGS.md integration/E_EMIT_UNSUPPORTED
// row): one function's `Hbc2jsError` must not abort the whole module. The
// shared per-function loop is `src/emit/index.ts`'s `emitOne`, used by both
// `decompile()` and `--split`'s `emitModule` call. This synthesises the
// failure via `EmitOptions.passes` (the earliest hook every function's
// decompile/emit funnels through) rather than hand-crafting an unsupported
// bytecode construct — the isolation mechanism doesn't care which stage of
// `emitOne`'s try raised the error, only that it was an `Hbc2jsError`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { emitModule, printProgram } from "../../../src/emit/index.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decompile, nodeCheck } from "../../../src/decompile.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function fixtureBytes(name: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, file)));
}

/** Decompiles with the M4 baseline (no readability passes) and hands back
 *  each function's own top-level JS AST, keyed by function index — mirrors
 *  `src/split/index.ts`'s `decompileAllBodies` without importing it (that
 *  file is another agent's lane). `failAt`, when given, makes exactly that
 *  function's tree-pass stage throw synthetically. */
function emitBodies(bytes: Uint8Array, failAt?: number): { readonly bodies: ReadonlyMap<number, Stmt>; readonly result: ReturnType<typeof emitModule> } {
  const module = parseHbc(bytes);
  const analysis = analyseModule(module, { strictEnv: true });
  const bodies = new Map<number, Stmt>();
  const result = emitModule(analysis, {
    moduleName: "isolation-test.hbc",
    ...(failAt === undefined
      ? {}
      : {
          passes: (fn, cfg) => {
            if (cfg.functionIndex === failAt) {
              throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, "synthetic isolation-test failure", { functionIndex: failAt, offset: 999 });
            }
            return { fn, diagnostics: [] };
          },
        }),
    astPasses: (fn, cfg) => {
      bodies.set(cfg.functionIndex, fn);
      return { fn, diagnostics: [] };
    },
  });
  return { bodies, result };
}

test("a single function's Hbc2jsError becomes a throwing stub, not a module-wide abort", () => {
  const bytes = fixtureBytes("22-nested-closures-counters", "v94.hbc");
  const module = parseHbc(bytes);
  assert.ok(module.functions.length >= 3, "fixture needs several functions for this test to mean anything");
  const target = module.functions.length - 1; // a leaf, non-global function

  const baseline = emitBodies(bytes);
  const failing = emitBodies(bytes, target);

  assert.equal(failing.result.stubbedFunctions, 1);
  const stubDiag = failing.result.diagnostics.find((d) => d.code === "W_FUNCTION_STUBBED");
  assert.ok(stubDiag !== undefined, "expected a W_FUNCTION_STUBBED diagnostic");
  assert.equal(stubDiag?.context.functionIndex, target);

  // Every function still produced *some* body — nothing else was dropped.
  assert.equal(failing.bodies.size, baseline.bodies.size);
  for (const i of baseline.bodies.keys()) assert.ok(failing.bodies.has(i), `fn#${i} missing from the isolated run`);

  const targetBefore = printProgram([baseline.bodies.get(target)!]);
  const targetAfter = printProgram([failing.bodies.get(target)!]);
  assert.notEqual(targetAfter, targetBefore);
  assert.match(targetAfter, new RegExp(`hbc2js: could not decompile fn#${target} `));
  assert.match(targetAfter, /throw new Error\(/);

  // A function nests its (hoisted) children's own declarations inside its own
  // printed body (§6 "Function nesting"), so an *ancestor* of the target
  // legitimately reprints differently too — it now embeds the stub instead of
  // the real body. Isolation's actual promise (item 3 of the brief) is about
  // functions the failure doesn't touch at all: anything whose printed text
  // doesn't mention fn#target is unrelated, and must be byte-identical.
  const marker = `fn#${target} "`;
  const unrelated = [...baseline.bodies.keys()].filter((i) => i !== target && !printProgram([baseline.bodies.get(i)!]).includes(marker));
  assert.ok(unrelated.length > 0, "fixture too small to exercise an unrelated function");
  for (const i of unrelated) {
    const before = printProgram([baseline.bodies.get(i)!]);
    const after = printProgram([failing.bodies.get(i)!]);
    assert.equal(after, before, `fn#${i} changed even though it does not contain fn#${target}`);
  }

  // The whole module still emits valid JavaScript.
  assert.equal(nodeCheck(failing.result.code).ok, true, failing.result.code);
});

test("a normal fixture never hits the isolation path (decompileDiagnostics stays 0)", () => {
  const bytes = fixtureBytes("22-nested-closures-counters", "v94.hbc");
  const result = decompile(bytes, { moduleName: "22-nested-closures-counters" });
  assert.equal(result.decompileDiagnostics, 0);
  assert.equal(
    result.diagnostics.filter((d) => d.code === "W_FUNCTION_STUBBED").length,
    0,
  );
  assert.equal(nodeCheck(result.code).ok, true, result.code);
});

test("the CLI prints no stub-count line for a normal fixture", () => {
  const r = spawnSync(process.execPath, [CLI, join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v94.hbc")], { encoding: "utf8", maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /could not be decompiled \(stubbed\)/);
});
