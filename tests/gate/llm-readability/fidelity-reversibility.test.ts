// Spec 28 section 7, the truth-first targets: fidelity (byte-identical
// apply-then-revert), reversibility (100%: reverting one transaction restores
// the prior tree exactly), traceability (100% of emitted files trace to binding
// IDs, zero orphans), and tree-level equiv. The structural rules are green
// today; every measurement over a real tree belongs to landing 1 or 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { FILE_OP_KINDS, equivAccepts, validateTransaction } from "../../../src/readability/types.ts";
import type { EquivProof, ReadabilityTransaction } from "../../../src/readability/types.ts";

const HAIKU_BACKEND_PATH = join(repoRoot(), "src", "workers", "backends", "haiku.ts");
const TXN_LOG_PATH = join(repoRoot(), "src", "readability", "transactions.ts");

const passing: EquivProof = {
  scope: "tree",
  verdict: "PASS",
  oracle: "hbc2js equiv --hbc bundle.hbc out/",
  coverage: { inputs: 64, records: 12043 },
  ts: "2026-09-11T00:00:00Z",
};

function tx(over: Partial<ReadabilityTransaction> = {}): ReadabilityTransaction {
  return {
    id: "abc123",
    op: "combine",
    who: "worker:haiku",
    tier: "suggested",
    ts: "2026-09-11T00:00:00Z",
    inputs: [{ module: 412 }, { module: 413 }],
    outputs: [{ path: "src/auth/LoginScreen.js", origins: [{ module: 412 }, { module: 413 }] }],
    equiv: passing,
    evidence: 'both modules load "/v1/auth/login"',
    prior: { files: [{ path: "src/module_412.js", sha256: "a".repeat(64) }, { path: "src/module_413.js", sha256: "b".repeat(64) }] },
    ...over,
  };
}

test("spec 28: a well-formed file-op transaction validates, and covers every documented op", () => {
  assert.deepEqual(validateTransaction(tx()), []);
  assert.deepEqual([...FILE_OP_KINDS], ["make", "rename", "move", "combine", "split"]);
  for (const op of FILE_OP_KINDS) {
    // `make` is the one op with no prior state; everything else must record it.
    const prior = op === "make" ? { files: [] } : tx().prior;
    assert.deepEqual(validateTransaction(tx({ op, prior })), [], `${op} should validate`);
  }
});

test("spec 28 section 7 (traceability): a file with no binding origin is an orphan and invalidates the transaction", () => {
  const problems = validateTransaction(tx({ outputs: [{ path: "src/mystery.js", origins: [] }] }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.code, "orphan-file");
  assert.match(problems[0]?.detail ?? "", /src\/mystery\.js/);

  const noInputs = validateTransaction(tx({ inputs: [] }));
  assert.ok(noInputs.some((p) => p.code === "no-inputs"));
});

test("spec 28 section 7 (reversibility): a non-make op with no recorded prior state is rejected", () => {
  const problems = validateTransaction(tx({ op: "split", prior: { files: [] } }));
  assert.ok(problems.some((p) => p.code === "not-reversible"));
});

test("spec 28 section 0a: accept iff the oracle says PASS -- INCONCLUSIVE is never PASS", () => {
  assert.equal(equivAccepts(passing), true);
  assert.equal(equivAccepts({ ...passing, verdict: "DIVERGENT" }), false);
  assert.equal(equivAccepts({ ...passing, verdict: "INCONCLUSIVE" }), false);
  for (const verdict of ["DIVERGENT", "INCONCLUSIVE"] as const) {
    const problems = validateTransaction(tx({ equiv: { ...passing, verdict } }));
    assert.ok(problems.some((p) => p.code === "equiv-not-passed"), `${verdict} must block the transaction`);
  }
});

test("spec 28 section 1: a worker can never write tier=confirmed -- it fills the suggested queue only", () => {
  const problems = validateTransaction(tx({ tier: "confirmed" }));
  assert.ok(problems.some((p) => p.code === "self-promoted"));
  // A human promoter writing the same transaction is fine.
  assert.deepEqual(validateTransaction(tx({ tier: "confirmed", who: "fred" })), []);
});

test("spec 28 section 7 (fidelity): decompiled JS is byte-identical with the overlay applied then reverted", (t) => {
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (naming path + equiv gate)`);
    return;
  }
  t.skip(
    "landing 1 owns this: render a fixture, apply a recorded LLM name set, revert it, assert the bytes match. " +
      "The overlay-only half is already covered by tests/gate/name-overlay/render.test.ts; this adds the LLM write path",
  );
});

test("spec 28 section 7 (reversibility): reverting any one transaction restores the prior tree exactly", (t) => {
  if (!existsSync(TXN_LOG_PATH)) {
    t.skip(`${TXN_LOG_PATH} does not exist yet -- spec 28 LANDING 3 (DB transaction log + file ops)`);
    return;
  }
  t.skip("landing 3 owns this: apply N transactions, revert each in turn, assert the tree hash returns to its predecessor");
});

test("spec 28 section 7 (traceability): 100% of emitted files trace to binding IDs on a real tree, zero orphans", (t) => {
  if (!existsSync(TXN_LOG_PATH)) {
    t.skip(`${TXN_LOG_PATH} does not exist yet -- spec 28 LANDING 3 (DB transaction log + file ops)`);
    return;
  }
  t.skip("landing 3 owns this: after a full file-op pass over the held-out app, every file has >= 1 origin");
});

test("spec 28 section 7 (tree fidelity): the reconstructed tree passes hbc2js equiv --hbc as a whole", (t) => {
  if (!existsSync(TXN_LOG_PATH)) {
    t.skip(`${TXN_LOG_PATH} does not exist yet -- spec 28 LANDING 3 (tree-level equiv gate)`);
    return;
  }
  t.skip("landing 3 owns this: run the tree-level oracle after make/rename/combine/split and require PASS");
});
