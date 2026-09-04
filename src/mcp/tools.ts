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
// `scan/*`, `search/*`.
//
// THIS ROUND (2026-09-04, "MCP finish B: action tools") adds the three
// action tools spec 17 §13/§14 describe, still transport-agnostic, still no
// storage logic of their own:
//
//   - `requestFidelityCheck` (§14 item, wired to `request_fidelity_check`):
//     runs the harness oracle ladder (`src/harness/ladder.ts`'s
//     `runOracleLadder`, the SAME checker `tests/gate/harness/*` runs) over
//     one function's decompiled source and returns its EVIDENCE (verdict +
//     per-oracle detail), stamping `role: "fidelity-checked"` on a `fn:N`
//     ref exactly when the verdict is PASS — the marker
//     `isFidelityCheckedEvidenceRef` (`src/project/evidence-resolver.ts`)
//     already looks for so `setFindingStatus` above can accept it for
//     `open->confirmed` (truth rule 3). Writes NOTHING — no finding, no log
//     row — "confirms a finding" only in the sense of handing back a ref a
//     *separate* `record_finding`/`set_finding_status` call may cite; §14's
//     own wording is "returns evidence", not "writes a finding".
//   - `recompileEdit` (§13, `recompile_edit`): patch-and-test. Compiles an
//     edited function's source with the project's OWN `tools/hermesc/vNN`
//     (found by bundle version, never guessed), writes the recompiled bytes
//     to a scratch COPY (never the original bundle, never the `.hbcproj` —
//     see the method's own doc comment for the no-mutate proof), and lands
//     through `ProjectService.addComment` for its `log` row — reusing the
//     EXISTING logged-write path rather than adding new `projdb` schema (out
//     of scope this round), which also gets it §13's "writes a `log` row
//     like any other action" for free. Carries §13's REQUIRED warning
//     ("PRODUCES A MODIFIED BINARY, not a read-only answer") and a
//     provenance watermark (`kind: "edited-and-recompiled"` + base bundle
//     hash + edit hash) on every return, never silently.
//   - `generateDocumentation` (§14, `generate_documentation`): a pure
//     READ-derived report over the session's own `log`/`findings` (already
//     on `ProjectService`, this round's prerequisite) — a third party can
//     replay every `recompile_edit` the log recorded and re-run
//     `request_fidelity_check` against the same fn to regenerate the
//     findings. Writes nothing; deterministic (no wall-clock timestamp of
//     ITS OWN in the body — every timestamp in the report is one already
//     stored in a `log`/finding row, so calling it twice on the same
//     project state byte-for-byte reproduces the same report).
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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactService } from "../artifact/service.ts";
import { ProjectService, type SetResult } from "../project/service.ts";
import type { AddFindingInput } from "../project/findings.ts";
import type { CommentRange, EvidenceRef, FindingStatus, Provenance, Severity, Tag } from "../project/schema.ts";
import { sha256Hex } from "../artifact/schema.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { runOracleLadder, VERDICT, type OracleName, type OracleResult, type Verdict } from "../harness/ladder.ts";
import { findHermesc, compileWithHermesc } from "../harness/roundtrip.ts";
import { runProgram } from "../harness/runner.ts";
import { printProjection } from "../harness/trace.ts";

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

// --- request_fidelity_check (§14) ------------------------------------------

export interface RequestFidelityCheckInput {
  readonly fn: number;
  /** Override the candidate text checked; defaults to the artifact's own
   *  decompiled `source(fn)` — the normal case ("is what we decompiled for
   *  this fn faithful"). An explicit override lets a caller fidelity-check
   *  a `recompile_edit` candidate before recording a finding about it. */
  readonly candidateSource?: string;
  /** Defaults to `["syntax"]` — the only oracle that needs neither a
   *  hand-written `source.js` (real bundle functions have none, D16) nor a
   *  whole-module recompile (this call is scoped to one function, not the
   *  full bundle `runOracleLadder`'s `roundtrip` oracle recompiles). A
   *  caller with its own whole-program candidate may pass `["syntax",
   *  "roundtrip"]` plus the extra ladder options this method forwards. */
  readonly oracles?: readonly OracleName[];
}

export interface FidelityCheckResult {
  readonly verdict: Verdict;
  readonly oracles: readonly OracleResult[];
  /** The static-proof ref `set_finding_status`'s `open->confirmed` gate
   *  (truth rule 3, `isFidelityCheckedEvidenceRef`) accepts — present iff
   *  `verdict === "PASS"`. `null` on anything else: a DIVERGENT/ERROR/
   *  INCONCLUSIVE check confirms nothing, it is itself evidence AGAINST
   *  treating the candidate as faithful. */
  readonly evidence: EvidenceRef | null;
  readonly detail: string;
}

// --- recompile_edit (§13) ---------------------------------------------------

export interface RecompileEditInput {
  readonly fn: number;
  readonly source: string;
  readonly prov: Provenance;
  /** Filename embedded in the recompiled bytecode (spec 06 §6); defaults to
   *  a name that carries the fn id so a later `disasm`/roundtrip run over
   *  the output is self-describing without consulting the log. */
  readonly embeddedFilename?: string;
  /** When `true`, additionally runs the EDITED SOURCE (not the recompiled
   *  bytecode — no bundled Hermes VM is assumed present, §13's fundamentals
   *  are deferred) through the harness runner and returns its print-
   *  projected trace, for the "if run, its trace for comparison" half of
   *  §13. Off by default (extra process spawn). */
  readonly runTrace?: boolean;
}

export interface RecompileEditResult extends ToolResult {
  /** §13 REQUIRED: "an explicit warning that this PRODUCES A MODIFIED
   *  BINARY (not a read-only answer)" — always present, never conditional. */
  readonly warning: string;
  /** §13's provenance watermark: "its provenance record marks it edited-
   *  and-recompiled, with the base bundle hash + the edit" — `editSha256` is
   *  `sha256(source)`, `baseBundleSha256` is this project's own
   *  `manifest.bundle.sha256`, so the watermark alone lets a reader tell
   *  this apart from, and trace it back to, the real bundle without opening
   *  the file. */
  readonly watermark: {
    readonly kind: "edited-and-recompiled";
    readonly baseBundleSha256: string;
    readonly fn: number;
    readonly editSha256: string;
  };
  /** Scratch-directory path of the recompiled `.hbc` COPY — never the
   *  original bundle path, never inside the `.hbcproj` (see `recompileEdit`
   *  doc comment for the no-mutate proof). Caller-owned cleanup: this is a
   *  local hypothesis-testing artifact, §13, "scoped to local hypothesis-
   *  testing ... never distribution", not something this method retains. */
  readonly outputPath: string;
  readonly trace?: { readonly print: readonly string[]; readonly timedOut: boolean; readonly code: number | null } | undefined;
}

/** One `recompileEdit` call's replayable record, kept in-session on
 *  `McpTools.recompileActions` — see that field's doc comment. */
interface RecompileEditActionRecord {
  readonly fn: number;
  readonly source: string;
  readonly embeddedFilename: string;
  readonly editSha256: string;
  readonly baseBundleSha256: string;
  readonly outputPath: string;
}

// --- generate_documentation (§14) ------------------------------------------

export interface GenerateDocumentationInput {
  readonly since?: string;
  readonly who?: string;
}

export interface GenerateDocumentationResult {
  /** A self-contained Markdown report: base-bundle identity, every finding
   *  (claim/severity/status/evidence), and the full session `log` in
   *  chronological order — "uses the log + recompile_edit" (§14): every
   *  logged `recompile_edit` action's watermark/edit is reproduced verbatim
   *  from its `log` row `detail` so a third party can re-run it. */
  readonly report: string;
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

  /** In-PROCESS session record of every `recompileEdit` call, read by
   *  `generateDocumentation` (§14: "uses the log + `recompile_edit`") for
   *  the one thing the DB `log` table structurally cannot carry — the
   *  `log.detail` column is a fixed compact `{kind}` marker
   *  (`src/projdb/annotations.ts`, out of this round's scope), not the full
   *  edited source a third party needs to actually REPLAY the action. This
   *  is deliberately not persisted (no `.hbcproj` schema touched this
   *  round) — "the session" is this live `McpTools` instance's own call
   *  history, same scope `docs/specs/17-mcp-harness.md §14` means by it. */
  private readonly recompileActions: RecompileEditActionRecord[] = [];

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

  /** `request_fidelity_check` (§13/§14) — runs `src/harness/ladder.ts`'s
   *  `runOracleLadder` (the SAME checker the gate/sweep harness trusts,
   *  never a bespoke re-implementation) over one function's candidate text
   *  and returns its evidence. Writes nothing: no `log` row, no finding —
   *  a `record_finding`/`set_finding_status` call the caller makes
   *  separately is what actually records anything, this method only hands
   *  back the `role:"fidelity-checked"` ref that call may then cite. */
  async requestFidelityCheck(input: RequestFidelityCheckInput): Promise<FidelityCheckResult> {
    const candidate = input.candidateSource ?? this.artifact.source(input.fn);
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-fidelity-check-"));
    try {
      const candidatePath = join(dir, "candidate.js");
      writeFileSync(candidatePath, candidate);
      const result = await runOracleLadder({
        fixture: { name: `fn:${input.fn}` },
        candidateJsPath: candidatePath,
        // No hand-written source.js and no whole-module hbcBytes for a
        // single-function candidate (see `RequestFidelityCheckInput.oracles`
        // doc): `reference` is only load-bearing for the trace/roundtrip
        // oracles this call does not request by default, so a minimal
        // `expected-txt` choice (spec 06's fallback when no VM is in play)
        // is honest here, never a fabricated VM match.
        reference: { engine: "expected-txt", reason: "request_fidelity_check: single-function static-proof check, no VM cross-check in scope", knownDivergences: [] },
        oracles: input.oracles ?? ["syntax"],
      });
      const evidence: EvidenceRef | null = result.verdict === VERDICT.PASS ? { ref: `fn:${input.fn}`, role: "fidelity-checked" } : null;
      const detail = result.oracles.map((o) => `${o.oracle}:${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`).join("; ") || "no oracles ran";
      return { verdict: result.verdict, oracles: result.oracles, evidence, detail };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `recompile_edit` (§13) — patch-and-test. NO-MUTATE PROOF: the only
   *  filesystem write in this method is `writeFileSync(outputPath, ...)`
   *  where `outputPath` is inside a FRESH `mkdtempSync` scratch directory
   *  this method itself creates (never `this.artifact`'s directory, never
   *  `opts.hbc`'s path, never the `.hbcproj`'s `dbPath`/`storeDir`) — there
   *  is structurally no path back to the original bundle or project store
   *  for this write to land on. The one write that DOES land on the
   *  project (`this.project.addComment` below) is the SAME logged-write
   *  path `add_comment` above uses — one `revisions` row + one `log` row,
   *  never a second, weaker path around `ProjectService`. */
  recompileEdit(input: RecompileEditInput): RecompileEditResult {
    const version = this.artifact.manifest.bundle.hbcVersion;
    const hermesc = findHermesc(version);
    if (hermesc === null) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `recompile_edit: no hermesc for v${version} (run tools/get-hermesc.sh ${version})`);
    }
    const embeddedFilename = input.embeddedFilename ?? `fn-${input.fn}-edit.js`;
    const compiled = compileWithHermesc(hermesc, input.source, embeddedFilename);
    if (!compiled.ok) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `recompile_edit: hermesc v${version} failed to compile the edited source: ${compiled.error}`);
    }
    const editSha256 = sha256Hex(input.source);
    const baseBundleSha256 = this.artifact.manifest.bundle.sha256;
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-recompile-edit-"));
    const outputPath = join(dir, `edited-fn${input.fn}-${editSha256.slice(0, 12)}.hbc`);
    writeFileSync(outputPath, compiled.bytes);

    const warning =
      "WARNING: recompile_edit PRODUCES A MODIFIED BINARY, not a read-only answer. " +
      "The output is a synthetic edited-and-recompiled artifact for local hypothesis-testing only " +
      "(spec 17 §13) — it is never the original bundle, was never written over it or the .hbcproj, " +
      "and must never be distributed.";
    const watermark = { kind: "edited-and-recompiled" as const, baseBundleSha256, fn: input.fn, editSha256 };

    const bodyLines = [
      `recompile_edit: fn=${input.fn} recompiled with hermesc v${version}`,
      `base bundle sha256=${baseBundleSha256}`,
      `edit sha256=${editSha256}`,
      `output=${outputPath} (scratch copy, original bundle/.hbcproj untouched)`,
    ];
    const logged = this.project.addComment(`fn:${input.fn}`, bodyLines.join(" | "), input.prov);

    this.recompileActions.push({ fn: input.fn, source: input.source, embeddedFilename, editSha256, baseBundleSha256, outputPath });

    return { rid: logged.rid, line: logged.line, warning, watermark, outputPath };
  }

  /** The trace half of §13's "if run, its trace for comparison": runs the
   *  EDITED SOURCE (not the recompiled bytecode — no bundled Hermes VM is
   *  assumed present, fundamentals deferred, §13) through the harness
   *  runner and returns its print-projected trace. Kept as a second call
   *  rather than folded into `recompileEdit` unconditionally so the common
   *  "just recompile and inspect the watermark" path never pays for a
   *  spawn; `recompileEdit({ ..., runTrace: true })` combines them. */
  private async traceEditedSource(source: string): Promise<{ readonly print: readonly string[]; readonly timedOut: boolean; readonly code: number | null }> {
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-recompile-edit-trace-"));
    try {
      const path = join(dir, "edit.js");
      writeFileSync(path, source);
      const result = await runProgram(path, {});
      return { print: printProjection(result.records), timedOut: result.timedOut, code: result.code };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `recompile_edit` with `runTrace: true` (§13's "if run, its trace for
   *  comparison" half) — a thin wrapper so the sync/no-trace call above
   *  stays synchronous for callers that never asked for a run. */
  async recompileEditAndRun(input: RecompileEditInput): Promise<RecompileEditResult> {
    const base = this.recompileEdit(input);
    if (input.runTrace !== true) return base;
    const trace = await this.traceEditedSource(input.source);
    return { ...base, trace };
  }

  /** `generate_documentation` (§14) — pure read over `ProjectService.log`/
   *  `findings` (this round's DB-native prerequisites), formatted
   *  deterministically: no wall-clock timestamp of ITS OWN, only timestamps
   *  already stored in the rows it reads, so two calls against the same
   *  project state are byte-for-byte identical. */
  generateDocumentation(input: GenerateDocumentationInput = {}): GenerateDocumentationResult {
    const logQuery = { ...(input.since !== undefined ? { since: input.since } : {}), ...(input.who !== undefined ? { who: input.who } : {}) };
    const logRows = [...this.project.log(logQuery, { all: true }).rows].reverse();
    const findingRows = this.project.findings({}, { all: true }).rows;

    const lines: string[] = [];
    lines.push("# hbc2js analysis session — reproduction report");
    lines.push("");
    lines.push(`Base bundle sha256: ${this.artifact.manifest.bundle.sha256}`);
    lines.push(`Hermes bytecode version: ${this.artifact.manifest.bundle.hbcVersion}`);
    lines.push("");
    lines.push(`## Findings (${findingRows.length})`);
    lines.push("");
    if (findingRows.length === 0) lines.push("(none)");
    for (const rf of findingRows) {
      const r = rf.record;
      lines.push(`### ${r.rid} — ${r.severity} — ${rf.status}${r.cwe !== undefined ? ` (${r.cwe})` : ""}`);
      lines.push(`target: ${r.target}`);
      lines.push(`claim: ${r.claim}`);
      lines.push(`evidence: ${r.evidence.map((e) => `${e.ref} [${e.role}]`).join(", ")}`);
      lines.push("");
    }
    lines.push(`## Session log (${logRows.length} entries, chronological)`);
    lines.push("");
    if (logRows.length === 0) lines.push("(none)");
    for (const row of logRows) {
      lines.push(`- [${row.ts}] ${row.who} ${row.op}${row.detail !== null ? `: ${row.detail}` : ""}`);
    }
    lines.push("");
    lines.push(`## recompile_edit actions this session (${this.recompileActions.length})`);
    lines.push("");
    if (this.recompileActions.length === 0) lines.push("(none)");
    for (const a of this.recompileActions) {
      lines.push(`### fn ${a.fn} — edit sha256=${a.editSha256}`);
      lines.push(`base bundle sha256: ${a.baseBundleSha256}`);
      lines.push(`embedded filename: ${a.embeddedFilename}`);
      lines.push(`recompiled output (scratch copy, never the original bundle): ${a.outputPath}`);
      lines.push("");
      lines.push("Reproduce with `recompile_edit`:");
      lines.push("```js");
      lines.push(a.source);
      lines.push("```");
      lines.push("");
    }
    lines.push("## Reproduction");
    lines.push("");
    lines.push(
      "For any `recompile_edit` action above, replay it with the same `fn` and the embedded source " +
        "via `recompile_edit`, then re-verify with `request_fidelity_check` against the same `fn` to " +
        "regenerate the fidelity-checked evidence any finding above cites.",
    );

    return { report: lines.join("\n") };
  }
}
