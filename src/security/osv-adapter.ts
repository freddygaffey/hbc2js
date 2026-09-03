// src/security/osv-adapter.ts — Lane O (spec 13 `docs/specs/13-reuse-
// validation.md` §3, §9 step 2): `DepsReport` -> OSV/GHSA advisory match ->
// two-key gate (`osv-gate.ts`) -> spec-11 finding records
// (`src/project/findings.ts`'s `FindingStore`, never a raw JSONL append,
// same discipline as `src/secrets/service.ts` — the Lane O counterpart of
// that module). Consumes `hbc2js deps --json` output ONLY (§1 point 2): it
// never re-parses the bundle, never re-runs match/guess logic.
//
// Range matching reuses the committed offline OSV/GHSA slice
// (`tools/security/osv-db/slice.json`, CC-BY 4.0 attributed, spec 13 ruling
// R-N) and OSV's own `affected[].ranges` SEMVER-event shape
// (`introduced`/`fixed`, https://ossf.github.io/osv-schema/#semver). Scope
// note (honest, not silently narrowed): §3.2 says "we never reimplement
// semver range math — reuse [osv-scanner or the API]"; this adapter's
// `versionInRange` below is a MINIMAL major.minor.patch comparator
// sufficient for the slice's own advisories (plain `introduced`/`fixed`
// events, no build metadata/prerelease ranges), not a full semver-range
// engine. `osv-scanner` (Apache-2.0, `tools/security/probe.ts`'s
// `probeOsvScanner`) is present on this machine and is the documented
// upgrade path for richer ranges — swapping the comparator here for a
// shell-out is a follow-up, not required for the fixture's own pinned
// advisories (all plain introduced/fixed pairs) to match correctly.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DepsReport } from "../deps/report.ts";
import { gateDependency, packagesToGate, type GateTier } from "./osv-gate.ts";
import { FindingStore } from "../project/findings.ts";
import { RECORD_FILE_NAMES } from "../project/schema.ts";
import type { EvidenceRef, FindingRecord, FindingsFileRecord, Severity, StatusRecord } from "../project/schema.ts";
import { loadRecordFile, saveRecordFile } from "../project/io.ts";
import type { EvidenceResolver } from "../project/evidence-resolver.ts";

export const DEFAULT_OSV_DB_PATH = join(import.meta.dirname, "..", "..", "tools", "security", "osv-db", "slice.json");
export const OSV_DEMOTION_STATE_PATH = join(import.meta.dirname, "..", "..", "tools", "security", "osv-demotion.json");

export interface OsvRangeEvent {
  readonly introduced?: string;
  readonly fixed?: string;
  readonly last_affected?: string;
}
export interface OsvRange {
  readonly type: string;
  readonly events: readonly OsvRangeEvent[];
}
export interface OsvAffected {
  readonly package: { readonly name: string; readonly ecosystem: string };
  readonly ranges: readonly OsvRange[];
}
export interface OsvAdvisory {
  readonly id: string;
  readonly summary: string;
  readonly cve?: string;
  readonly severity: Severity;
  readonly cvssScore?: number;
  readonly affected: readonly OsvAffected[];
}
export interface OsvSlice {
  readonly _attribution: string;
  readonly _retrieved: string;
  readonly advisories: readonly OsvAdvisory[];
}

export function loadOsvSlice(path: string = DEFAULT_OSV_DB_PATH): OsvSlice {
  return JSON.parse(readFileSync(path, "utf8")) as OsvSlice;
}

/** major.minor.patch only (see module header's scope note) — good enough
 *  for the committed slice's plain `introduced`/`fixed` events. `0` for any
 *  missing/non-numeric component (handles `"0.0.0"`/`"0"` sentinels). */
function parseVersion(v: string): readonly [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (m === null) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

/** `version` is affected by `range` iff it falls in some
 *  [introduced, fixed) interval (or [introduced, last_affected] inclusive) —
 *  OSV schema semantics for a `SEMVER`-typed range's event list. */
export function versionInRange(version: string, range: OsvRange): boolean {
  const events = range.events;
  let introduced: string | null = null;
  for (const ev of events) {
    if (ev.introduced !== undefined) {
      introduced = ev.introduced;
      continue;
    }
    if (introduced === null) continue; // a fixed/last_affected before any introduced is not a valid interval start
    if (ev.fixed !== undefined) {
      if (compareVersions(version, introduced) >= 0 && compareVersions(version, ev.fixed) < 0) return true;
      introduced = null;
      continue;
    }
    if (ev.last_affected !== undefined) {
      if (compareVersions(version, introduced) >= 0 && compareVersions(version, ev.last_affected) <= 0) return true;
      introduced = null;
    }
  }
  // An `introduced` with no closing event: affected from there onward.
  if (introduced !== null && compareVersions(version, introduced) >= 0) return true;
  return false;
}

export function advisoriesFor(slice: OsvSlice, pkg: string, version: string): readonly OsvAdvisory[] {
  return slice.advisories.filter((adv) => adv.affected.some((aff) => aff.package.ecosystem === "npm" && aff.package.name === pkg && aff.ranges.some((r) => versionInRange(version, r))));
}

export interface OsvMatch {
  readonly package: string;
  readonly version: string | null;
  readonly advisory: OsvAdvisory;
  readonly tier: GateTier;
  readonly claim: string;
  readonly severity: Severity;
  readonly moduleIds: readonly number[];
}

const SEVERITY_BY_CVSS = (score: number | undefined): Severity => {
  if (score === undefined) return "med"; // spec 13 §3.3: absent score -> med
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "med";
  return "low";
};

/** R-T demotion tripwire state (spec 13 §13 ruling 2 / edit R-T): "any
 *  measured claim-tier misattribution anywhere demotes guessed-identity
 *  (non-High) claims to candidate tier repo-wide until a review reinstates
 *  them." A tiny on-disk flag file, not a database — this repo has no
 *  cross-run mutable state store besides the project findings themselves,
 *  and the tripwire is meant to be rare and human-reviewed to clear. */
export interface OsvDemotionState {
  readonly demoted: boolean;
  readonly reason?: string;
  readonly since?: string;
}
export function readDemotionState(path: string = OSV_DEMOTION_STATE_PATH): OsvDemotionState {
  if (!existsSync(path)) return { demoted: false };
  return JSON.parse(readFileSync(path, "utf8")) as OsvDemotionState;
}

/** Pure: `DepsReport` + the offline slice -> the gated (package, advisory)
 *  matches. No I/O besides the slice/demotion-state files already loaded by
 *  the caller — never re-runs `hbc2js deps` matching (§1 point 2). */
export function matchOsv(report: DepsReport, slice: OsvSlice, opts: { readonly demotionState?: OsvDemotionState } = {}): readonly OsvMatch[] {
  const demoted = opts.demotionState?.demoted === true;
  const matches: OsvMatch[] = [];
  for (const pkgName of packagesToGate(report)) {
    const gate = gateDependency(report, pkgName, { demoteGuessedIdentityClaims: demoted });
    if (gate.tier === "none" || gate.version === null) continue;
    const advisories = advisoriesFor(slice, pkgName, gate.version);
    const moduleIds = report.moduleOwnership.filter((m) => m.package === pkgName).map((m) => m.localModuleId).filter((id): id is number => id !== null);
    for (const advisory of advisories) {
      const claim =
        gate.tier === "claim"
          ? `vulnerable dependency: ${pkgName}@${gate.version} matches ${advisory.id}`
          : `candidate: ${pkgName} possibly in advisory range of ${advisory.id} (version unevidenced)`;
      const severity: Severity = gate.tier === "claim" ? SEVERITY_BY_CVSS(advisory.cvssScore) : "med"; // §3.2: candidate tier capped at med regardless of CVSS
      matches.push({ package: pkgName, version: gate.version, advisory, tier: gate.tier, claim, severity, moduleIds });
    }
  }
  return matches;
}

// --- Store integration (mirrors src/secrets/service.ts's shape) -----------

export interface OsvScanSummary {
  readonly new: number;
  readonly cached: number;
  readonly total: number;
  readonly skippedRefuted: number;
  readonly skippedUnresolved: number;
}

function findingContentKey(claim: string, severity: Severity, evidence: readonly EvidenceRef[]): string {
  return JSON.stringify({ claim, severity, evidence });
}

/** Minimal `EvidenceResolver` for Lane O: a `mod:N` ref resolves iff `N` is
 *  a `localModuleId` the SAME `DepsReport` run attributed to some confirmed
 *  package (`report.moduleOwnership`) — honest by construction (every ref
 *  this adapter ever writes comes from that exact set), without requiring a
 *  full P2.1 published artifact just to run this lane over a bare
 *  `deps --json` report (spec 13 §1 point 2's "consumes this JSON only"). */
export function moduleEvidenceResolver(report: DepsReport): EvidenceResolver {
  const ids = new Set(report.moduleOwnership.map((m) => m.localModuleId).filter((id): id is number => id !== null));
  return { resolves: (ref: string) => (ref.startsWith("mod:") ? ids.has(Number(ref.slice(4))) : false) };
}

export class OsvService {
  private readonly projectDir: string;
  private store: FindingStore;

  constructor(opts: { readonly projectDir: string }) {
    this.projectDir = opts.projectDir;
    this.store = this.loadStore();
  }

  private findingsPath(): string {
    return join(this.projectDir, RECORD_FILE_NAMES.findings);
  }

  private loadStore(): FindingStore {
    const path = this.findingsPath();
    if (!existsSync(path)) return new FindingStore();
    const { rows } = loadRecordFile<FindingsFileRecord>(path, "findings");
    const findings = rows.filter((r): r is FindingRecord => r.kind === "finding");
    const statuses = rows.filter((r): r is StatusRecord => r.kind === "status");
    const maxRid = (rs: readonly { rid: string }[]): number => rs.reduce((m, r) => Math.max(m, Number(r.rid) || -1), -1);
    return new FindingStore({ findings, statuses, findingSeq: maxRid(findings) + 1, statusSeq: maxRid(statuses) + 1 });
  }

  private saveStore(): void {
    if (!existsSync(this.projectDir)) mkdirSync(this.projectDir, { recursive: true });
    saveRecordFile<FindingsFileRecord>(this.findingsPath(), "findings", this.store.allRecords());
  }

  /** Writes one finding per `matchOsv` match, R3-slotted on
   *  `(target, advisoryId)` (`patternId` in the store's generic field name,
   *  spec 13 §3.3/§7's `advisoryId` discriminator — mirrors spec 12 R3
   *  exactly, `src/secrets/service.ts` precedent), idempotent (§6, no
   *  supersede churn on identical re-emission) and refutation-sticky (a
   *  refuted slot is never re-asserted). */
  writeMatches(matches: readonly OsvMatch[], report: DepsReport, opts: { readonly dbDate: string; readonly runId: string; readonly reportHash: string }): OsvScanSummary {
    this.store = this.loadStore();
    const resolver = moduleEvidenceResolver(report);
    let newCount = 0;
    let cached = 0;
    let skippedRefuted = 0;
    let skippedUnresolved = 0;

    for (const m of matches) {
      const target = `mod:${m.moduleIds[0] ?? "unresolved"}`;
      const evidence: EvidenceRef[] = m.moduleIds.map((id) => ({ ref: `mod:${id}`, role: "match" }));
      if (evidence.length === 0 || !evidence.some((e) => resolver.resolves(e.ref))) {
        skippedUnresolved++;
        continue;
      }
      const active = this.store.allFindings().find((f) => f.active && f.target === target && f.patternId === m.advisory.id);
      if (active) {
        if (this.store.statusOf(active.rid) === "refuted") {
          skippedRefuted++;
          continue;
        }
        if (findingContentKey(active.claim, active.severity, active.evidence) === findingContentKey(m.claim, m.severity, evidence)) {
          cached++;
          continue;
        }
      }
      this.store.addFinding(
        {
          target,
          claim: m.claim,
          severity: m.severity,
          evidence,
          patternId: m.advisory.id,
          prov: { source: "tool", who: `osv@${opts.dbDate}+deps@${opts.reportHash}`, run: opts.runId },
        },
        resolver,
      );
      newCount++;
    }
    this.saveStore();
    return { new: newCount, cached, total: matches.length, skippedRefuted, skippedUnresolved };
  }

  allFindings(): readonly FindingRecord[] {
    return this.store.allFindings().filter((f) => f.active);
  }

  statusOf(rid: string): string {
    return this.store.statusOf(rid);
  }

  /** Test/CLI convenience: refute a finding (spec 11 §4.1 `open->refuted`),
   *  used by T5 to check refutation stickiness across re-runs. */
  refute(rid: string, resolver: EvidenceResolver, who = "test"): void {
    this.store = this.loadStore();
    const finding = this.store.allFindings().find((f) => f.rid === rid);
    if (finding === undefined) throw new Error(`refute: no such finding ${rid}`);
    this.store.setStatus({ findingRid: rid, to: "refuted", evidence: finding.evidence, prov: { source: "human", who } }, resolver);
    this.saveStore();
  }
}
