// A-STATUS (spec 11 §6, §7 step 4): `open->confirmed` refused without a
// dynamic-role evidence ref; accepted with one; `refuted` needs
// counter-evidence; each transition is an append-only record with
// provenance; refuted is sticky; a tool may never self-confirm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindingStore, checkStatusTransition } from "../../src/project/findings.ts";
import type { EvidenceResolver } from "../../src/project/evidence-resolver.ts";
import type { Provenance } from "../../src/project/schema.ts";

function mockResolver(knownRefs: readonly string[]): EvidenceResolver {
  const known = new Set(knownRefs);
  return { resolves: (ref) => known.has(ref) };
}

const human: Provenance = { source: "human", who: "analyst@duck.com" };
const llm: Provenance = { source: "llm", who: "llm-run-3", run: "llm-run-3" };
const tool: Provenance = { source: "tool", who: "secrets-indexer", run: "scan:abc:v1:1" };

function seedFinding(store: FindingStore, resolver: EvidenceResolver, prov: Provenance = llm) {
  const { record } = store.addFinding(
    { target: "fn:42", claim: "user-controlled response flows into eval", severity: "high", evidence: [{ ref: "fn:42", role: "source" }], prov },
    resolver,
  );
  return record;
}

test("A-STATUS-a open->confirmed is refused without a dynamic-role evidence ref", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42", "fn:57"]);
  const f = seedFinding(store, resolver);
  assert.throws(
    () => store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "fn:57", role: "context" }], prov: human }, resolver),
    /dynamic-role/,
  );
});

test("A-STATUS-b open->confirmed is accepted with a resolving dynamic-role ref", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42", "trace:campaign1/seed-777007"]);
  const f = seedFinding(store, resolver);
  const { record } = store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }], prov: human }, resolver);
  assert.equal(record.from, "open");
  assert.equal(record.to, "confirmed");
  assert.equal(store.statusOf(f.rid), "confirmed");
});

test("A-STATUS-c a dynamic-role ref that does not resolve still refuses the confirm", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42"]); // trace ref below is unknown to the resolver
  const f = seedFinding(store, resolver);
  assert.throws(
    () => store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-unknown", role: "dynamic" }], prov: human }, resolver),
    /resolving evidence/,
  );
});

test("A-STATUS-d refuted needs counter-evidence (zero/unresolving evidence is refused)", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42"]);
  const f = seedFinding(store, resolver);
  assert.throws(() => store.setStatus({ findingRid: f.rid, to: "refuted", evidence: [], prov: human }, resolver), /resolving evidence/);
  const { record } = store.setStatus({ findingRid: f.rid, to: "refuted", evidence: [{ ref: "fn:42", role: "context", note: "docs example key" }], prov: human }, resolver);
  assert.equal(record.to, "refuted");
});

test("A-STATUS-e refuted is sticky — no further transition, in either direction", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42", "trace:campaign1/seed-777007"]);
  const f = seedFinding(store, resolver);
  store.setStatus({ findingRid: f.rid, to: "refuted", evidence: [{ ref: "fn:42", role: "context" }], prov: human }, resolver);
  assert.throws(
    () => store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }], prov: human }, resolver),
    /sticky/,
  );
  assert.throws(() => store.setStatus({ findingRid: f.rid, to: "open", evidence: [{ ref: "fn:42", role: "context" }], prov: human }, resolver), /sticky/);
});

test("A-STATUS-f a tool may never self-confirm a finding", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["sid:1203", "trace:campaign1/seed-777007"]);
  const { record: f } = store.addFinding(
    { target: "sid:1203", claim: "candidate AWS access key id", severity: "high", evidence: [{ ref: "sid:1203", role: "match" }], prov: tool, patternId: "aws-akid" },
    resolver,
  );
  assert.throws(
    () => store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }], prov: tool }, resolver),
    /never self-confirm/,
  );
  // A human CAN confirm the same tool-authored finding, given dynamic evidence.
  const { record: s } = store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }], prov: human }, resolver);
  assert.equal(s.to, "confirmed");
});

test("A-STATUS-g each transition is its own append-only record, carrying provenance, retrievable via history", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42", "trace:campaign1/seed-777007"]);
  const f = seedFinding(store, resolver);
  store.setStatus({ findingRid: f.rid, to: "confirmed", evidence: [{ ref: "trace:campaign1/seed-777007", role: "dynamic" }], prov: human }, resolver);
  const history = store.statusHistory(f.rid);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.prov.who, "analyst@duck.com");
  assert.equal(history[0]!.active, true);
  // The finding row itself never mutates its own `status` field (§1.5) —
  // live status comes from the status chain, not the finding record.
  assert.equal(f.status, "open");
});

test("A-STATUS-h a write with no prov is rejected (§4.2, shared with addFinding)", () => {
  const store = new FindingStore();
  const resolver = mockResolver(["fn:42"]);
  const f = seedFinding(store, resolver);
  assert.throws(() => store.setStatus({ findingRid: f.rid, to: "refuted", evidence: [{ ref: "fn:42", role: "context" }], prov: undefined as unknown as Provenance }, resolver));
});

test("A-STATUS-i checkStatusTransition is a pure pre-flight with the same verdicts", () => {
  const resolver = mockResolver(["fn:42", "trace:x"]);
  assert.equal(
    checkStatusTransition("open", "confirmed", [{ ref: "fn:42", role: "context" }], human, resolver),
    "open->confirmed requires >=1 resolving dynamic-role evidence ref (trace:/fuzz:/repro:) OR a resolving fidelity-checked static proof ref (role:\"fidelity-checked\") — §4.1 as revised by spec 17 §14: a static-only, non-checked claim cannot self-promote",
  );
  assert.equal(checkStatusTransition("open", "confirmed", [{ ref: "trace:x", role: "dynamic" }], human, resolver), null);
  assert.equal(checkStatusTransition("refuted", "open", [{ ref: "fn:42", role: "context" }], human, resolver), "refuted is sticky — a refuted finding never transitions again (§1.5 reviewed rule)");
});

test("A-STATUS-j §14 fix: open->confirmed also accepts a resolving fidelity-checked STATIC proof ref (not just dynamic)", () => {
  const resolver = mockResolver(["fn:42"]);
  assert.equal(checkStatusTransition("open", "confirmed", [{ ref: "fn:42", role: "fidelity-checked" }], human, resolver), null);
  // a static ref with any OTHER role still cannot self-promote — the fix
  // broadens WHAT counts as confirming evidence, it doesn't drop the gate.
  assert.notEqual(checkStatusTransition("open", "confirmed", [{ ref: "fn:42", role: "context" }], human, resolver), null);
});
