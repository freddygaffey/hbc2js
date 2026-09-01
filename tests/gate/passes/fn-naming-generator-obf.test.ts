// Regression for docs/BUGS.md's `23-generator-basic`/`26-infinite-generator-
// take` row (QUEUE 6): `decompile()` with every pass on threw `E_UNBOUND_IDENT
// ("r3" ... not declared in any enclosing scope)` on both fixtures' v94 `.obf`
// variant only (`--passes=none` was fine).
//
// Root cause, bisected with `--no-pass <name>` over every registered rung
// (`src/cli.ts --list-passes`): `fn-naming` is the pass whose rewrite happens
// to fire *inside* the generator body function's own statement list (renaming
// its nested closures, e.g. `tzgCz`/`PPDcB` above), which is what flips
// `astPassHook`'s `r.applied.length > 0` gate and runs the framework's
// `pruneRegisterDecls` (F10, `src/passes/index.ts`) on that site for the
// first time — any other rung that fired there would have triggered the same
// bug, `fn-naming` just happens to be the one that does on this fixture.
// `--no-pass fn-naming` alone makes both fixtures decompile clean; every
// other rung skipped alone still threw (see this commit's message for the
// full bisection).
//
// The actual defect was in the framework, not `fn-naming`: `emit/
// function.ts`'s generator/async lowering returns a resume-dispatcher closure
// (`return function (__sent, __isReturn, __isThrow) {...}`) that is a
// `k:"func"` AST node but — unlike every other `k:"func"` node — is *not* a
// separate Hermes `CreateClosure`; it is the same frame's own state machine,
// sharing the enclosing function's registers directly. `src/passes/ast.ts`'s
// `countUses` (the primitive behind `identUses`/`registerUses`, which
// `pruneRegisterDecls` calls) assumed every `k:"func"` boundary is a genuine
// separate register frame (Hermes restarts `r0` per function) and never
// followed a register name across one — sound for every real closure, wrong
// for this one synthetic exception, so a register read only inside the
// resume closure counted as 0 uses and `pruneRegisterDecls` dropped its
// entire `let r0, r1, …` declaration out from under a live read.
//
// Fix: `Expr`'s `func` variant (`src/emit/ast.ts`) grew an optional
// `sameFrame?: true`, set only at that one construction site
// (`emit/function.ts`), and `countUses` treats a `sameFrame` closure as
// transparent — not a frame boundary — for every name, registers included.
// General rule, not a generator special case: any future construct that
// reuses this "closure over the same frame's own registers" shape gets the
// same correct liveness for free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

const FIXTURES = ["23-generator-basic", "26-infinite-generator-take"] as const;

for (const name of FIXTURES) {
  test(`${name}/v94.obf: decompile() with every pass on no longer throws E_UNBOUND_IDENT`, () => {
    const bytes = readFileSync(join(repoRoot(), "tests/fixtures/constructs", name, "v94.obf.hbc"));
    let result;
    try {
      result = decompile(bytes);
    } catch (e) {
      if (e instanceof Hbc2jsError && e.code === ErrorCode.E_UNBOUND_IDENT) {
        assert.fail(`decompile() threw E_UNBOUND_IDENT: ${e.message}`);
      }
      throw e;
    }
    assert.ok(
      result.diagnostics.every((d) => (d as { code?: string }).code !== "E_UNBOUND_IDENT"),
      "no diagnostic may carry E_UNBOUND_IDENT either",
    );
  });
}

test("23-generator-basic / 26-infinite-generator-take: .obf traces PASS at v94 under the oracle with passes on", async () => {
  const only = FIXTURES.map((n) => `${n}.obf`);
  const report = await runTier({ tier: "hardened", decompiler: hbc2jsDecompiler, only, versions: [94] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.equal(report.summary.pass, 2, `expected exactly 2 PASS checks (one per fixture at v94), got ${JSON.stringify(report.summary)}`);
});

// The general sweep of every construct fixture's `.obf` variant at every
// version (which includes v94 and v99) already runs in
// `tests/sweep/decompile/sweep.test.ts`'s "T6" hardened-tier check
// (`npm run test:all`) — not duplicated here, since that full sweep takes
// minutes and this file only needs the two fixtures the bug was found on to
// stay in the fast gate.
