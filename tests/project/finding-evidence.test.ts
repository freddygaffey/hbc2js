// P2 (spec 11 §6, pre-implementation) — a finding requires resolving
// evidence, run "against a mock ArtifactService resolver" as the spec
// prescribes. No `src/project/*` module exists yet (step 0 ships no code,
// spec 11 §7): `findingIsValid` below is a test-local reference
// implementation of the ONE rule spec 11 §4.1 pins precisely —
//
//   "Every finding REQUIRES >=1 evidence ref, and every ref must RESOLVE...
//    A finding with zero resolving refs is REJECTED at write time."
//
// — checked against a hand-rolled mock resolver standing in for the real
// `ArtifactService` (which step 4 wires in for real, spec 11 §7). This test
// exercises the RULE, not a future API; when step 4 lands
// `ProjectService.setFinding*`, that step's own tests exercise the real
// resolver, and may additionally point this file at the real implementation.
import { test } from "node:test";
import assert from "node:assert/strict";

interface EvidenceRef {
  readonly ref: string;
  readonly role: string;
}

interface FindingDraft {
  readonly evidence: readonly EvidenceRef[];
}

/** Stands in for `ArtifactService`'s id/trace/fuzz resolution (spec 11
 *  §4.1): a set of refs the mock artifact/trace/fuzz store knows about. */
interface MockResolver {
  resolves(ref: string): boolean;
}

function mockResolver(knownRefs: readonly string[]): MockResolver {
  const known = new Set(knownRefs);
  return { resolves: (ref) => known.has(ref) };
}

/** §4.1's write-time acceptance rule: a finding needs >=1 evidence ref AND
 *  at least one of those refs must resolve. Zero refs, or refs that are all
 *  unknown, are both rejections — a ref-that-doesn't-resolve is not "no
 *  evidence", it is invalid evidence, same outcome (never a live finding). */
function findingIsValid(finding: FindingDraft, resolver: MockResolver): boolean {
  if (finding.evidence.length === 0) return false;
  return finding.evidence.some((e) => resolver.resolves(e.ref));
}

test("P2a a finding with zero evidence refs is rejected", () => {
  const resolver = mockResolver(["fn:42", "reg:42:7"]);
  assert.equal(findingIsValid({ evidence: [] }, resolver), false);
});

test("P2b a finding whose only refs are unknown ids is rejected", () => {
  const resolver = mockResolver(["fn:42", "reg:42:7"]);
  const draft: FindingDraft = {
    evidence: [
      { ref: "fn:999", role: "source" },
      { ref: "sid:999999", role: "context" },
    ],
  };
  assert.equal(findingIsValid(draft, resolver), false);
});

test("P2c a finding with one resolving ref is accepted", () => {
  const resolver = mockResolver(["fn:42", "reg:42:7"]);
  const draft: FindingDraft = {
    evidence: [
      { ref: "fn:999", role: "source" }, // still unresolved
      { ref: "reg:42:7", role: "sink" }, // resolves
    ],
  };
  assert.equal(findingIsValid(draft, resolver), true);
});

test("P2d trace/fuzz refs resolve through the same mock (dynamic evidence, §4.1/§4.3)", () => {
  const resolver = mockResolver(["trace:campaign1/seed-777007"]);
  const draft: FindingDraft = { evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }] };
  assert.equal(findingIsValid(draft, resolver), true);
});

test("P2e the sample store's fixture finding f-1 resolves under a resolver seeded with its own targets", () => {
  // Cross-check against the hand-written sample fixture (tests/project/sample-store),
  // so P1's fixture and P2's rule agree on what "resolving" means for the
  // exact finding spec 11 §1.5 uses as its worked example.
  const resolver = mockResolver(["reg:42:7", "fn:57", "sid:1203"]);
  const draft: FindingDraft = {
    evidence: [
      { ref: "reg:42:7", role: "source" },
      { ref: "fn:57", role: "sink" },
      { ref: "sid:1203", role: "context" },
    ],
  };
  assert.equal(findingIsValid(draft, resolver), true);
});
