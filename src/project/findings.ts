// The `findings` record type — docs/specs/11-project-store.md §1.5, §2.1,
// §4.1, §7 step 4. Two record kinds share `findings.jsonl` (schema.ts's
// `FindingsFileRecord` union): `finding` rows (the claim) and `status` rows
// (append-only `open->confirmed/refuted` transitions, never a mutation of
// the finding row — §1.5). This module wraps TWO `RevisionStore` engines,
// one per kind, because their slot keys mean different things:
//
// - A finding's slot is `(target, patternId)` when `patternId` is given (the
//   R3 discriminator, spec 12 §4.2, ratified into spec 11 §2.1's bracket: a
//   mechanically-proposed finding re-emitted for the same target+pattern
//   supersedes its own prior finding, never a DIFFERENT pattern's), or an
//   EXPLICIT caller-supplied `slot` (revising a known finding). With
//   neither, `addFinding` mints a FRESH slot per call — `${target} #${rid}`,
//   where `rid` is the record's own about-to-be-minted id (peeked via
//   `engine.currentSeq()` before `set()`, so it's deterministic, not
//   random) — because spec 11 places no discriminator on ordinary human/LLM
//   findings, and a target legitimately carries several independent claims
//   at once (an XSS finding and a prototype-pollution finding on the same
//   fn are not the same assertion); collapsing them onto `target` alone
//   would silently supersede one with the other, exactly the failure R3
//   fixed for tool findings.
// - A status transition's slot is the FINDING's `rid` — one append-only
//   transition chain per finding, independent of `target`/`patternId`.
//
// Evidence resolution (write-time REQUIRED, §4.1) and the status-transition
// rules (§4.1/§4.3, A-STATUS) live here; the real `ArtifactService`-backed
// resolver is `evidence-resolver.ts`'s `ArtifactEvidenceResolver`, injected
// by the caller (this module takes any `EvidenceResolver`, same as `tags.ts`
// takes any `Provenance` — no direct `ArtifactService` import here, keeping
// this module resolver-agnostic like `hasResolvingEvidence` already is).
import { RevisionStore } from "./revision-store.ts";
import type { Revision } from "./revision-store.ts";
import { assertProvenance } from "./schema.ts";
import type { CtxSnapshot, EvidenceRef, FindingRecord, FindingStatus, Provenance, Severity, StatusRecord } from "./schema.ts";
import { hasResolvingEvidence, isDynamicEvidenceRef, isFidelityCheckedEvidenceRef, type EvidenceResolver } from "./evidence-resolver.ts";

type FindingFields = Pick<FindingRecord, "target" | "claim" | "severity" | "evidence" | "cwe" | "patternId" | "prov" | "ctx">;
type StatusFields = Pick<StatusRecord, "target" | "finding" | "from" | "to" | "evidence" | "prov" | "ctx">;

export interface AddFindingInput {
  readonly target: string;
  readonly claim: string;
  readonly severity: Severity;
  readonly evidence: readonly EvidenceRef[];
  readonly prov: Provenance;
  /** R3 slot discriminator (see module header) — set by mechanical
   *  producers (spec 12's secrets indexer) so re-emitting the same
   *  target+pattern supersedes only its own prior finding. */
  readonly patternId?: string;
  /** Explicit slot to revise a known finding (its own `AddFindingResult.slot`
   *  from a prior call) instead of minting a fresh one. Mutually exclusive
   *  with `patternId` in practice — a caller with a stable pattern identity
   *  should just pass `patternId` again. */
  readonly slot?: string;
  readonly cwe?: string;
  readonly ctx?: CtxSnapshot;
  readonly ts?: string;
}

export interface AddFindingResult {
  readonly record: FindingRecord;
  readonly superseded: FindingRecord | null;
  /** The slot key this finding was written to — pass back as `opts.slot` on
   *  a later `addFinding` call to revise it (append-only supersession). */
  readonly slot: string;
}

export interface SetStatusInput {
  readonly findingRid: string;
  readonly to: FindingStatus;
  readonly evidence: readonly EvidenceRef[];
  readonly prov: Provenance;
  readonly ctx?: CtxSnapshot;
  readonly ts?: string;
}

export interface SetStatusResult {
  readonly record: StatusRecord;
  readonly superseded: StatusRecord | null;
}

/** A finding plus its live-computed evidence-resolution state (§3.3/§4.1):
 *  never cached, recomputed against whatever resolver the caller passes. */
export interface ResolvedFinding {
  readonly record: FindingRecord;
  readonly status: FindingStatus;
  readonly valid: boolean;
  readonly refs: readonly { readonly ref: EvidenceRef; readonly resolved: boolean }[];
}

function findingSlotKey(target: string, patternId: string | undefined): string {
  return patternId !== undefined ? `${target} ${patternId}` : target;
}

function toFindingRecord(r: Revision<FindingFields>): FindingRecord {
  const { target, claim, severity, evidence, cwe, patternId, prov, ctx } = r.value;
  return {
    rid: r.rid,
    kind: "finding",
    target,
    prov,
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx,
    claim,
    severity,
    evidence,
    status: "open", // the finding row's own `status` never mutates (§1.5) — live status is `StatusStore`'s job.
    ...(cwe !== undefined ? { cwe } : {}),
    ...(patternId !== undefined ? { patternId } : {}),
  };
}

function toFindingRevision(r: FindingRecord, slot: string): Revision<FindingFields> {
  return {
    rid: r.rid,
    target: slot,
    value: {
      target: r.target,
      claim: r.claim,
      severity: r.severity,
      evidence: r.evidence,
      prov: r.prov,
      ctx: r.ctx,
      ...(r.cwe !== undefined ? { cwe: r.cwe } : {}),
      ...(r.patternId !== undefined ? { patternId: r.patternId } : {}),
    },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

function toStatusRecord(r: Revision<StatusFields>): StatusRecord {
  const { target, finding, from, to, evidence, prov, ctx } = r.value;
  return { rid: r.rid, kind: "status", target, prov, ts: r.ts, supersedes: r.supersedes, active: r.active, ctx, finding, from, to, evidence };
}

function toStatusRevision(r: StatusRecord): Revision<StatusFields> {
  return {
    rid: r.rid,
    target: r.finding, // slot = the finding's rid (module header)
    value: { target: r.target, finding: r.finding, from: r.from, to: r.to, evidence: r.evidence, prov: r.prov, ctx: r.ctx },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

/** `open->confirmed`/`refuted` transition legality (§4.1/§4.3, A-STATUS).
 *  Pure so both `setStatus` (below) and a future CLI/`ProjectService` layer
 *  (step 5) can pre-flight a transition without minting a record. */
export function checkStatusTransition(
  from: FindingStatus,
  to: FindingStatus,
  evidence: readonly EvidenceRef[],
  prov: Provenance,
  resolver: EvidenceResolver,
): string | null {
  if (from === to) return `already ${to}`;
  if (from === "refuted") return "refuted is sticky — a refuted finding never transitions again (§1.5 reviewed rule)";
  if (to === "confirmed" && prov.source === "tool") {
    return "a tool may never self-confirm a finding (spec 12 §4.3 reviewed rule, generalised to every tool producer)";
  }
  if (!hasResolvingEvidence(evidence, resolver)) return "status transition needs >=1 resolving evidence ref (§4.1)";
  if (
    to === "confirmed" &&
    !evidence.some((e) => (isDynamicEvidenceRef(e) || isFidelityCheckedEvidenceRef(e)) && resolver.resolves(e.ref))
  ) {
    return "open->confirmed requires >=1 resolving dynamic-role evidence ref (trace:/fuzz:/repro:) OR a resolving fidelity-checked static proof ref (role:\"fidelity-checked\") — §4.1 as revised by spec 17 §14: a static-only, non-checked claim cannot self-promote";
  }
  return null;
}

export class FindingStore {
  private readonly findingsEngine: RevisionStore<FindingFields>;
  private readonly statusEngine: RevisionStore<StatusFields>;

  constructor(init?: { readonly findings?: readonly FindingRecord[]; readonly statuses?: readonly StatusRecord[]; readonly findingSeq?: number; readonly statusSeq?: number }) {
    const findingRevisions = (init?.findings ?? []).map((r) => toFindingRevision(r, findingSlotKey(r.target, r.patternId)));
    this.findingsEngine = new RevisionStore<FindingFields>({
      records: findingRevisions,
      ...(init?.findingSeq !== undefined ? { seq: init.findingSeq } : {}),
    });
    this.statusEngine = new RevisionStore<StatusFields>({
      records: (init?.statuses ?? []).map(toStatusRevision),
      ...(init?.statusSeq !== undefined ? { seq: init.statusSeq } : {}),
    });
  }

  set now(fn: () => string) {
    this.findingsEngine.now = fn;
    this.statusEngine.now = fn;
  }

  /** Every finding ever written, oldest first — persisted through
   *  `io.ts`'s `saveRecordFile("findings", …)` alongside `allStatuses()`. */
  allFindings(): readonly FindingRecord[] {
    return this.findingsEngine.allRecords().map(toFindingRecord);
  }

  allStatuses(): readonly StatusRecord[] {
    return this.statusEngine.allRecords().map(toStatusRecord);
  }

  /** Both files' rows interleaved as `findings.jsonl` stores them (§2.2:
   *  one file, sorted by `(target, rid)` across both kinds). */
  allRecords(): readonly (FindingRecord | StatusRecord)[] {
    return [...this.allFindings(), ...this.allStatuses()];
  }

  /** §4.1's write-time gate: >=1 evidence ref, all valid shape, >=1 must
   *  resolve — REJECTS (throws) otherwise; a finding is never free text
   *  (§1.5) and never written with unresolving-only evidence. */
  addFinding(input: AddFindingInput, resolver: EvidenceResolver): AddFindingResult {
    assertProvenance(input.prov, "addFinding");
    if (!hasResolvingEvidence(input.evidence, resolver)) {
      throw new Error(
        `addFinding: rejected — a finding needs >=1 evidence ref and at least one must resolve (spec 11 §4.1); got ${input.evidence.length} ref(s), none resolving`,
      );
    }
    const slot = input.slot ?? (input.patternId !== undefined ? findingSlotKey(input.target, input.patternId) : `${input.target} #${this.findingsEngine.currentSeq()}`);
    const value: FindingFields = {
      target: input.target,
      claim: input.claim,
      severity: input.severity,
      evidence: input.evidence,
      prov: input.prov,
      ctx: input.ctx ?? {},
      ...(input.cwe !== undefined ? { cwe: input.cwe } : {}),
      ...(input.patternId !== undefined ? { patternId: input.patternId } : {}),
    };
    const { record, superseded } = this.findingsEngine.set(slot, value, input.ts);
    return { record: toFindingRecord(record), superseded: superseded ? toFindingRecord(superseded) : null, slot };
  }

  /** The live status of a finding: the `to` of its latest active status
   *  transition, or `"open"` (a finding's own creation status) when none
   *  exists yet. */
  statusOf(findingRid: string): FindingStatus {
    return this.statusEngine.get(findingRid)?.value.to ?? "open";
  }

  /** The full status-transition chain for one finding, newest first. */
  statusHistory(findingRid: string): readonly StatusRecord[] {
    return this.statusEngine.history(findingRid).map(toStatusRecord);
  }

  /** §4.1/§4.3's transition rules (A-STATUS), broadened by spec 17 §14:
   *  `open->confirmed` needs a resolving DYNAMIC-role ref OR a resolving
   *  fidelity-checked static-proof ref; `refuted` is sticky (once refuted,
   *  never transitions again); a tool-provenance transition can never
   *  confirm (self-confirm is refused regardless of evidence). Throws
   *  naming the violated rule; never silently downgrades or drops the
   *  request. */
  setStatus(input: SetStatusInput, resolver: EvidenceResolver): SetStatusResult {
    assertProvenance(input.prov, "setStatus");
    const finding = this.findingsEngine.allRecords().find((r) => r.rid === input.findingRid);
    if (finding === undefined) throw new Error(`setStatus: no such finding ${JSON.stringify(input.findingRid)}`);
    const from = this.statusOf(input.findingRid);
    const violation = checkStatusTransition(from, input.to, input.evidence, input.prov, resolver);
    if (violation !== null) throw new Error(`setStatus: rejected — ${violation}`);
    const value: StatusFields = { target: finding.value.target, finding: input.findingRid, from, to: input.to, evidence: input.evidence, prov: input.prov, ctx: input.ctx ?? {} };
    const { record, superseded } = this.statusEngine.set(input.findingRid, value, input.ts);
    return { record: toStatusRecord(record), superseded: superseded ? toStatusRecord(superseded) : null };
  }

  /** §3.3/§4.1's read-time liveness check, live-computed against `resolver`
   *  every call, never cached: a finding whose evidence no longer resolves
   *  (stale re-decompile) comes back `valid:false`. Per-ref resolution is
   *  included so a `finding show`-style caller (step 5) can render it. */
  resolve(record: FindingRecord, resolver: EvidenceResolver): ResolvedFinding {
    const refs = record.evidence.map((ref) => ({ ref, resolved: resolver.resolves(ref.ref) }));
    return { record, status: this.statusOf(record.rid), valid: hasResolvingEvidence(record.evidence, resolver), refs };
  }

  /** §3.1 `project findings [--tag] [--severity] [--status]` — bounded,
   *  live-resolved read: invalid findings (§4.1, stale evidence) are
   *  EXCLUDED from this query, same as a prior re-decompile orphaning a
   *  target — never shown as a live finding. Default cap 50 rows + total
   *  (§3.1's bound), `page.all` lifts it. */
  findings(
    resolver: EvidenceResolver,
    query: { readonly severity?: Severity; readonly status?: FindingStatus; readonly target?: string } = {},
    page: { readonly all?: boolean } = {},
  ): { readonly rows: readonly ResolvedFinding[]; readonly total: number; readonly truncated: boolean } {
    const cap = 50;
    const live = this.findingsEngine
      .allRecords()
      .filter((r) => r.active)
      .map((r) => this.resolve(toFindingRecord(r), resolver))
      .filter((rf) => rf.valid)
      .filter((rf) => query.severity === undefined || rf.record.severity === query.severity)
      .filter((rf) => query.status === undefined || rf.status === query.status)
      .filter((rf) => query.target === undefined || rf.record.target === query.target);
    const limit = page.all === true ? live.length : cap;
    return { rows: live.slice(0, limit), total: live.length, truncated: live.length > limit };
  }

  /** §3.1 `project finding show <id>` — the full record + resolution status
   *  REGARDLESS of validity (an invalid finding is excluded from `findings`
   *  but never hidden from a direct lookup by id — §4.1: "not shown live",
   *  not vanished). `null` when no such rid exists at all. */
  finding(rid: string, resolver: EvidenceResolver): ResolvedFinding | null {
    const r = this.findingsEngine.allRecords().find((rev) => rev.rid === rid);
    return r === undefined ? null : this.resolve(toFindingRecord(r), resolver);
  }

  /** §3.1 `project for-fn`'s findings slice: every active finding whose
   *  `target` is `target`, live-resolved, invalid ones excluded — same rule
   *  as `findings()`, scoped to one target instead of the whole store. */
  forTarget(target: string, resolver: EvidenceResolver): readonly ResolvedFinding[] {
    return this.findings(resolver, { target }, { all: true }).rows;
  }
}
