// src/mcp/tools.ts — docs/specs/17-mcp-harness.md §2 (as revised §14): the
// WRITE tools of the MCP analysis surface. TRANSPORT-AGNOSTIC, same
// discipline as `src/mcp/resources.ts` (§1's READ resources): this file has
// no MCP protocol/SDK binding (deferred, §6), just a plain class,
// `McpTools`, over its own `ArtifactService`/`ProjectService` pair, built
// the same way `McpResources` builds its own (one instance per project
// directory).
//
// §2's own framing: "The write tools below all land through
// `ProjectService`'s logged write path (spec 16 §1.2): each write is
// exactly one append to the annotation stratum plus exactly one `log` row
// ... There is no write to the DB that is not a tool call, and no tool call
// that writes without a `log` row (spec 16 A3)." That contract is what this
// round's prerequisite (`src/project/service.ts`'s DB write path) makes
// true for a `.hbcproj`-backed project — every method below is a THIN
// pass-through onto a `ProjectService` write verb, which is where the
// one-append-plus-one-log-row transaction actually happens
// (`src/projdb/annotations.ts`'s `db*` verbs, or the JSONL engine's
// `RevisionStore.set` for a JSONL-backed project). This file adds no
// storage logic of its own — it only shapes tool inputs into
// `ProjectService` calls and tool outputs into the spec's capped
// confirmation shapes.
//
// Out of scope this round (later agents, §2/§14): `leads`/`security-sinks`,
// `scan/*`, `search/*`, `request_fidelity_check`, `recompile_edit`,
// `generate_documentation`.
//
// --- THE TRUTH RULES (transcribed from spec 17 §2, verbatim in substance)
// this file enforces structurally, not just by prompt convention:
//
// 1. **`record_finding` cannot fabricate.** "the write path resolves every
//    `ref` against the shared `ArtifactService` ... and the trace/fuzz
//    artifact store, and REJECTS a finding with no resolving ref." Enforced
//    by `ProjectService.addFinding` (both backends: `hasResolvingEvidence`
//    checked before any row is written) — `recordFinding` below adds no
//    weaker path around it.
// 2. **No self-confirm.** "An assistant may not confirm its own claim:
//    promotion to `confirmed` needs a *dynamic* evidence ref ... never from
//    another static read the same assistant just made" — broadened by §14
//    to also accept a fidelity-checked static proof (below), but the
//    self-confirm gate itself is unchanged: "a tool may never self-confirm a
//    finding" (`checkStatusTransition`, `src/project/findings.ts`) refuses
//    ANY `prov.source === "tool"` confirm regardless of evidence.
// 3. **`set_finding_status → confirmed` accepts EITHER a dynamic repro OR a
//    fidelity-checked STATIC proof** (§14, BINDING, supersedes §2's
//    dynamic-only table row): "Dynamic-only over-constrains: a hardcoded
//    key, or a signature parsed-but-never-checked, is provable from the
//    code alone. Broaden what counts as confirming evidence; keep the
//    evidence gate." Implemented as `isDynamicEvidenceRef(e) ||
//    isFidelityCheckedEvidenceRef(e)` in `checkStatusTransition` — a static
//    ref only counts once its `role` is stamped `"fidelity-checked"` (the
//    marker an independent checker, e.g. a future `request_fidelity_check`,
//    would stamp — not something a tool's own static read can claim for
//    itself, since nothing on THIS surface currently stamps that role).
import { ArtifactService } from "../artifact/service.ts";
import { ProjectService, type SetResult } from "../project/service.ts";
import type { AddFindingInput } from "../project/findings.ts";
import type { CommentRange, EvidenceRef, FindingStatus, Provenance, Severity, Tag } from "../project/schema.ts";

export interface McpToolsOpts {
  readonly hbc?: string;
  readonly overlayStorePath?: string;
}

/** §2's uniform write-tool output shape: a single capped confirmation line
 *  (never more — "1 line" / "1-line confirmation" / "cap ≤ 1 line" is every
 *  write row's own published cap), plus the record id a caller needs to
 *  refer back to the write (e.g. `record_finding`'s id for a later
 *  `set_finding_status` call). */
export interface ToolResult {
  readonly rid: string;
  readonly line: string;
}

export interface SetNameInput {
  readonly target: string;
  readonly name: string;
  readonly prov: Provenance;
}

export interface AddCommentInput {
  readonly target: string;
  readonly body: string;
  readonly prov: Provenance;
  readonly range?: CommentRange;
}

export interface AddTagInput {
  readonly target: string;
  readonly tag: Tag;
  readonly prov: Provenance;
  readonly note?: string;
}

export interface RecordFindingInput {
  /** §2's `class` column — the finding's severity tier (`low`/`med`/`high`/
   *  `critical`, `schema.ts`'s `Severity`), the one closed classification
   *  a `FindingRecord` carries; a free-text vulnerability class is the
   *  `claim` prose plus optional `cwe` below. */
  readonly class: Severity;
  readonly location: { readonly fn: number; readonly reg?: number };
  readonly claim: string;
  /** REQUIRED to be non-empty AND at least one entry must resolve — see
   *  truth rule 1 above; `ProjectService.addFinding` is what actually
   *  enforces this, this type only documents the contract. */
  readonly evidence: readonly EvidenceRef[];
  readonly prov: Provenance;
  readonly cwe?: string;
}

export interface SetFindingStatusInput {
  readonly findingRid: string;
  readonly to: FindingStatus;
  readonly evidence: readonly EvidenceRef[];
  readonly prov: Provenance;
}

function locationTarget(location: { readonly fn: number; readonly reg?: number }): string {
  return location.reg !== undefined ? `reg:${location.fn}:${location.reg}` : `fn:${location.fn}`;
}

function toToolResult(r: SetResult): ToolResult {
  return { rid: r.rid, line: r.line };
}

/** The transport-agnostic business-logic core of spec 17's MCP WRITE
 *  surface (§2 as revised §14) — one instance scoped to one project
 *  directory, building its own `ArtifactService`/`ProjectService` pair the
 *  same way `McpResources` does (this round does not share a live pair
 *  across the two classes — deferred to the transport binding, §6, which
 *  decides whether one MCP server process holds one shared pair or one
 *  each). */
export class McpTools {
  readonly artifact: ArtifactService;
  readonly project: ProjectService;

  constructor(artifactDir: string, opts: McpToolsOpts = {}) {
    this.artifact = new ArtifactService(artifactDir, opts);
    this.project = new ProjectService(artifactDir, this.artifact);
  }

  /** `set_name` (§2): binding-id + name, `ProjectService.setName` (DB-
   *  backed this round — see that method's own doc comment for the JSONL
   *  scope gap). */
  setName(input: SetNameInput): ToolResult {
    return toToolResult(this.project.setName(input.target, input.name, input.prov));
  }

  /** `add_comment` (§2): target (fn/reg/env) + body + optional range,
   *  `ProjectService.addComment` — ref-resolved on write by the store's own
   *  `ctx` snapshot (no separate resolve-or-reject gate; a comment is not a
   *  finding, spec 11 §1.5). */
  addComment(input: AddCommentInput): ToolResult {
    return toToolResult(this.project.addComment(input.target, input.body, input.prov, input.range !== undefined ? { range: input.range } : undefined));
  }

  /** `add_tag` (§2): binding-id + tag + optional note,
   *  `ProjectService.setTag`. Mechanically-proposed tags stamped
   *  `source:"tool"` (spec 11 §4.2) — the caller's own `prov.source`
   *  decides that, this method does not second-guess it. */
  addTag(input: AddTagInput): ToolResult {
    return toToolResult(this.project.setTag(input.target, input.tag, input.prov, input.note !== undefined ? { note: input.note } : undefined));
  }

  /** `record_finding` (§2) — TRUTH RULE 1 above: `ProjectService.addFinding`
   *  REJECTS (throws `Hbc2jsError(E_USAGE, …)`) a finding with zero
   *  resolving evidence refs, both backends, before any row is written. A
   *  finding is always minted `status: "open"` (truth rule 2's structural
   *  half: nothing on this surface can create an already-`confirmed`
   *  finding — self-confirm is refused at CREATION as well as at
   *  transition). */
  recordFinding(input: RecordFindingInput): ToolResult {
    const addInput: AddFindingInput = {
      target: locationTarget(input.location),
      claim: input.claim,
      severity: input.class,
      evidence: input.evidence,
      prov: input.prov,
      ...(input.cwe !== undefined ? { cwe: input.cwe } : {}),
    };
    return toToolResult(this.project.addFinding(addInput));
  }

  /** `set_finding_status` (§2 as revised §14) — TRUTH RULES 2+3 above:
   *  `ProjectService.setFindingStatus` -> `checkStatusTransition` REJECTS
   *  (throws) a `confirmed` transition unless the evidence includes a
   *  resolving dynamic-role ref (`trace:`/`fuzz:`/`repro:`) OR a resolving
   *  `role:"fidelity-checked"` static ref, and unconditionally refuses ANY
   *  `prov.source === "tool"` confirm (no self-confirm, regardless of
   *  evidence — a `tool` provenance can never satisfy either branch of the
   *  `confirmed` gate). */
  setFindingStatus(input: SetFindingStatusInput): ToolResult {
    return toToolResult(this.project.setFindingStatus(input.findingRid, input.to, input.evidence, input.prov));
  }
}
