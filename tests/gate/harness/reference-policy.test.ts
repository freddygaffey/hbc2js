// docs/specs/06-harness.md §4, §11 item 3, §12 acceptance — reference policy
// unit tests: all three rules, plus HA-06's throw-vs-caveat distinction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseReference, KNOWN_DIVERGENT_FIXTURES, KNOWN_VERSIONS } from "../../../src/harness/reference-policy.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";

const NON_DIVERGENT_FIXTURE = { name: "01-if-else-chain" };
const DIVERGENT_FIXTURE = { name: "18-closure-loop-let" };

test("rule 1: a matching Hermes VM present -> hermes-vm, for every version this repo can build/fetch one", () => {
  for (const v of [84, 94, 99]) {
    if (findHermesVm(v) === null) continue; // environment-dependent; see docs/TOOLCHAIN.md
    const choice = chooseReference(NON_DIVERGENT_FIXTURE, v);
    assert.equal(choice.engine, "hermes-vm");
    assert.ok(choice.vm !== undefined);
    assert.equal(choice.vm?.hbcVersion, v);
  }
});

test("rule 1 applies regardless of known-divergence status (no VM caveat needed), but still records the construct informationally", () => {
  for (const v of [84, 94, 99]) {
    if (findHermesVm(v) === null) continue;
    const choice = chooseReference(DIVERGENT_FIXTURE, v);
    assert.equal(choice.engine, "hermes-vm");
    assert.deepEqual(choice.knownDivergences, [DIVERGENT_FIXTURE.name]);
  }
});

test("rule 2: no VM, not a known-divergence construct -> expected-txt, no caveat", () => {
  const choice = chooseReference({ name: "99-does-not-exist-and-is-not-divergent" }, 98);
  assert.equal(choice.engine, "expected-txt");
  assert.deepEqual(choice.knownDivergences, []);
});

test("rule 3: no VM, known-divergence construct -> expected-txt WITH a caveat, even at an unmeasured version (v96/v98)", () => {
  for (const name of Object.keys(KNOWN_DIVERGENT_FIXTURES)) {
    for (const v of [96, 98]) {
      if (findHermesVm(v) !== null) continue; // would take rule 1 instead
      const choice = chooseReference({ name }, v);
      assert.equal(choice.engine, "expected-txt");
      assert.deepEqual(choice.knownDivergences, [name], `${name} v${v} must carry a caveat`);
      assert.match(choice.reason, /unmeasured|no Hermes VM|InternalBytecode/);
    }
  }
});

test("the four known divergences are populated for 84/89/94/99 (spec 06 §4's table, from the AGENT-LOG measurement)", () => {
  const expected = ["18-closure-loop-let", "20-let-const-tdz", "42-rest-params", "49-arguments-object"];
  assert.deepEqual(Object.keys(KNOWN_DIVERGENT_FIXTURES).sort(), expected.sort());
  for (const name of expected) {
    const row = KNOWN_DIVERGENT_FIXTURES[name]!;
    for (const v of [84, 89, 94, 99]) {
      assert.equal(row[v], "diverges", `${name} v${v} should be measured "diverges"`);
    }
    assert.equal(row[96], undefined, `${name} v96 should be explicitly unmeasured, not assumed`);
    assert.equal(row[98], undefined, `${name} v98 should be explicitly unmeasured, not assumed`);
  }
});

test("HA-06: throws on an unmeasured, NON-divergent (fixture, version) pair rather than silently guessing", () => {
  assert.throws(() => chooseReference(NON_DIVERGENT_FIXTURE, 12345), /not in KNOWN_VERSIONS/);
});

test("HA-06 counterpart: an unmeasured version does NOT throw for a known-divergence construct — it caveats instead", () => {
  // 12345 has no VM (findHermesVm returns null for any version this repo has
  // never heard of), and is not in KNOWN_VERSIONS, but the fixture IS a named
  // known-divergence construct, so the policy still has a defensible answer.
  const choice = chooseReference(DIVERGENT_FIXTURE, 12345);
  assert.equal(choice.engine, "expected-txt");
  assert.deepEqual(choice.knownDivergences, [DIVERGENT_FIXTURE.name]);
});

test("KNOWN_VERSIONS carries the versions D14 has an opinion about", () => {
  assert.deepEqual([...KNOWN_VERSIONS].sort((a, b) => a - b), [84, 89, 94, 96, 98, 99]);
});
