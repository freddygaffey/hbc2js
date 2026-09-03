// P2 (spec 11 §6, pre-implementation) — a finding requires resolving
// evidence, run "against a mock ArtifactService resolver" as the spec
// prescribes.
//
//   "Every finding REQUIRES >=1 evidence ref, and every ref must RESOLVE...
//    A finding with zero resolving refs is REJECTED at write time."
//
// Step 4 (spec 11 §7) landed `src/project/evidence-resolver.ts`; this file
// is now repointed at its real `EvidenceResolver` type and
// `hasResolvingEvidence` rule (renamed from the test-local `findingIsValid`,
// same logic) per its own header's "may additionally point this file at the
// real implementation" — the RESOLVER stays a hand-rolled mock, exactly as
// spec 11 §6 prescribes for P2 ("runnable against a mock ArtifactService
// resolver"); the real `ArtifactService`-backed resolver
// (`ArtifactEvidenceResolver`) is exercised directly by
// `tests/project/evidence-resolver.test.ts`, and the status-transition
// rules P2 doesn't cover are `tests/project/finding-status.test.ts` (A-STATUS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasResolvingEvidence, type EvidenceResolver } from "../../src/project/evidence-resolver.ts";
import type { EvidenceRef } from "../../src/project/schema.ts";

interface FindingDraft {
  readonly evidence: readonly EvidenceRef[];
}

function mockResolver(knownRefs: readonly string[]): EvidenceResolver {
  const known = new Set(knownRefs);
  return { resolves: (ref) => known.has(ref) };
}

function findingIsValid(finding: FindingDraft, resolver: EvidenceResolver): boolean {
  return hasResolvingEvidence(finding.evidence, resolver);
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
