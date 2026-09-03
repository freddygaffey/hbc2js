// src/secrets/service.ts — spec 12 §9 steps 2-3: the scan driver + store
// integration. Reads ONLY the P2.1 artifact's published files directly
// (`strings.json` + `string-uses.jsonl`, spec 10 §2.3a/§2.3b) — no bundle,
// no `src/parse`/`src/disasm` (spec 12 §1). Writes finding records through
// `src/project/findings.ts`'s `FindingStore` (the R3 patternId-slot writer),
// never a raw JSONL append (spec 12 §9's "reuse explicitly" list).
//
// Scope note (deferred, not silently dropped): spec 12 §4.2/ruling-1 asks for
// six new `tags.jsonl` category values (`endpoint|deeplink|sql|flag|debug|
// asset`) landing in `src/project/schema.ts`'s `TAGS` — that file is
// `src/project/**`, owned by a concurrent agent on this task's brief, so this
// step does NOT write tag records for those categories yet; `classify()`
// still returns their (untiered) hits, but `scan()` only persists secret-tier
// (`finding`) hits. `hosts()`/`paths()` (the tag-derived network-surface
// view, §3.3) are stubbed empty pending that taxonomy landing. See the
// landing report for the follow-up.
//
// Refutation stickiness (R1, store-driven, spec 12 §4.3): before writing a
// (target, patternId) slot, `scan()` looks up that slot's CURRENT active
// finding (if any) and its live status; if `refuted`, the hit is skipped —
// re-emission never resurrects a refuted finding, surviving pattern-set
// bumps because pattern ids are append-only (§2.2) and the slot key never
// changes shape. Idempotence (§6): a hit whose claim/severity/evidence/ctx
// are byte-identical to the slot's current active record is also skipped (no
// supersede churn) — `prov.run`'s scan-id counter is excluded from that
// comparison on purpose, it always changes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FindingStore } from "../project/findings.ts";
import { ArtifactEvidenceResolver, type ArtifactExistenceCheck } from "../project/evidence-resolver.ts";
import { RECORD_FILE_NAMES } from "../project/schema.ts";
import type { EvidenceRef, FindingRecord, FindingsFileRecord, Severity, StatusRecord } from "../project/schema.ts";
import { loadRecordFile, saveRecordFile } from "../project/io.ts";
import type { StringRow, StringUseRow } from "../artifact/schema.ts";
import { classify, type Hit } from "./classify.ts";
import { PATTERN_SET_VERSION } from "./patterns.ts";
import type { Tier } from "./patterns.ts";

const SECRETS_DIR = "secrets";
const SCAN_STATE_FILE = "scan-state.json";

const SEVERITY_BY_TIER: Record<Tier, Severity> = { A: "high", B: "med", C: "low" };

/** Human-readable claim labels (spec 12 §4.2's worked example, generalised).
 *  Candidate language throughout (§3.5) — never a liveness claim. */
const CLAIM_LABELS: Record<string, string> = {
  "aws-akid": "AWS access key id",
  "aws-secret-ctx": "AWS secret access key (context-paired)",
  "gcp-api-key": "Google Cloud API key",
  "firebase-config": "Firebase API key (context-paired)",
  "stripe-key": "Stripe API key",
  "github-token": "GitHub token",
  "slack-token": "Slack token",
  "twilio-sid-key": "Twilio Account/API key SID",
  jwt: "JSON Web Token",
  "pem-block": "PEM private key block",
  "basic-auth-url": "URL with embedded basic-auth credentials",
  "generic-entropy-b64": "high-entropy base64 blob",
  "generic-entropy-hex": "high-entropy hex blob",
};

export interface ScanSummary {
  readonly new: number;
  readonly cached: number;
  readonly total: number;
  readonly skippedRefuted: number;
  readonly wallTimeMs: number;
}

export interface FindingRow {
  readonly id: string;
  readonly kind: "finding";
  readonly target: string;
  readonly status: string;
  readonly severity: Severity;
  readonly evidence: readonly EvidenceRef[];
  readonly prov: { readonly source: string; readonly who: string; readonly run?: string };
  readonly ctx: { readonly tier?: Tier; readonly patternSetVersion?: string; readonly patternId?: string; readonly [k: string]: unknown };
}

interface ScanStateFile {
  readonly patternSetVersion: string;
  readonly verdicts: Record<string, Hit[]>;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function readStringsIndex(artifactDir: string): readonly StringRow[] {
  const raw = JSON.parse(readFileSync(join(artifactDir, "strings.json"), "utf8")) as { entries: StringRow[] };
  return raw.entries;
}

function readStringUses(artifactDir: string): readonly StringUseRow[] {
  const path = join(artifactDir, "string-uses.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return lines.slice(1).filter((l) => l.length > 0).map((l) => JSON.parse(l) as StringUseRow);
}

/** The scanned text for a string row (§3.6): the full value, or — for a
 *  truncated (>4KB) row — the 256-char head only, never fetched further. */
function scannedText(row: StringRow): string {
  return "v" in row ? row.v : row.head;
}

function findingContentKey(claim: string, severity: Severity, evidence: readonly EvidenceRef[], ctx: unknown): string {
  return JSON.stringify({ claim, severity, evidence, ctx });
}

export class SecretsService {
  private readonly artifactDir: string;
  private readonly rows: readonly StringRow[];
  private readonly usesBySid: Map<number, StringUseRow[]>;
  private readonly bundleHash8: string;
  private store: FindingStore;
  private nextRun = 0;

  constructor(opts: { readonly artifactDir: string }) {
    this.artifactDir = opts.artifactDir;
    this.rows = readStringsIndex(this.artifactDir);
    this.usesBySid = new Map();
    for (const u of readStringUses(this.artifactDir)) {
      const list = this.usesBySid.get(u.sid) ?? [];
      list.push(u);
      this.usesBySid.set(u.sid, list);
    }
    this.bundleHash8 = sha256Hex(readFileSync(join(this.artifactDir, "strings.json"), "utf8")).slice(0, 8);
    this.store = this.loadStore();
  }

  private findingsPath(): string {
    return join(this.artifactDir, "project", RECORD_FILE_NAMES.findings);
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
    const dir = join(this.artifactDir, "project");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    saveRecordFile<FindingsFileRecord>(this.findingsPath(), "findings", this.store.allRecords());
  }

  private resolver(): ArtifactEvidenceResolver {
    const sids = new Set(this.rows.map((r) => r.sid));
    const fns = new Set<number>();
    for (const list of this.usesBySid.values()) for (const u of list) fns.add(u.fn);
    const check: ArtifactExistenceCheck = { hasFn: (fn) => fns.has(fn), hasString: (sid) => sids.has(sid), hasModule: () => false };
    return new ArtifactEvidenceResolver(check);
  }

  private loadScanState(): ScanStateFile {
    const path = join(this.artifactDir, SECRETS_DIR, SCAN_STATE_FILE);
    if (!existsSync(path)) return { patternSetVersion: PATTERN_SET_VERSION, verdicts: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ScanStateFile;
    if (parsed.patternSetVersion !== PATTERN_SET_VERSION) return { patternSetVersion: PATTERN_SET_VERSION, verdicts: {} };
    return parsed;
  }

  private saveScanState(state: ScanStateFile): void {
    const dir = join(this.artifactDir, SECRETS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SCAN_STATE_FILE), JSON.stringify(state, null, 2) + "\n");
  }

  /** §9 step 2/3: one streaming pass over `strings.json`, classify + join
   *  xref, write findings through `FindingStore` (R3 slot, R1 store-driven
   *  refuted-stickiness, §6 idempotence). Secret-tier hits only (module
   *  header: tag categories deferred pending the spec-11 taxonomy landing). */
  scan(opts?: { readonly force?: boolean }): ScanSummary {
    const start = Date.now();
    this.store = this.loadStore(); // re-read: another writer (e.g. an analyst refuting a finding) may have moved the slot since construction.
    const force = opts?.force === true;
    const state = force ? { patternSetVersion: PATTERN_SET_VERSION, verdicts: {} } : this.loadScanState();
    const resolver = this.resolver();

    let newCount = 0;
    let cachedCount = 0;
    let skippedRefuted = 0;
    let scanId = 0;

    for (const row of this.rows) {
      const text = scannedText(row);
      const key = sha256Hex(text);
      let hits: Hit[];
      const cached = state.verdicts[key];
      if (!force && cached !== undefined) {
        hits = cached;
        cachedCount++;
      } else {
        hits = classify(text);
        state.verdicts[key] = hits;
      }

      const isTruncated = !("v" in row);
      // §4.2 "one finding per (sid, patternId)": a pattern may match the
      // SAME string more than once (e.g. two base64 blobs in one long
      // string) — group by patternId so every match becomes an extra
      // `match` evidence ref on ONE finding, never competing writes to the
      // same (target,patternId) store slot. Before this grouping, two hits
      // of the same pattern on one string alternately superseded each other
      // every scan (span [0,36] then [37,74] then back), so `new` was never
      // 0 on re-scan even with an unchanged bundle — T4's idempotence bug.
      const byPattern = new Map<string, Hit[]>();
      for (const hit of hits) {
        if (hit.tier === undefined) continue; // tag-only category — deferred (module header).
        const list = byPattern.get(hit.patternId) ?? [];
        list.push(hit);
        byPattern.set(hit.patternId, list);
      }
      for (const [patternId, patternHits] of byPattern) {
        // Tier should be uniform per pattern on one string (the §3.4 proxy
        // gates on the whole string's own text), but if matches ever
        // disagree, keep the most confident (A best) — never silently drop
        // a stronger signal because a later match in the same string was
        // weaker.
        const tierRank: Record<Tier, number> = { A: 0, B: 1, C: 2 };
        const tier = patternHits.reduce<Tier>((best, h) => (tierRank[h.tier!] < tierRank[best] ? h.tier! : best), patternHits[0]!.tier!);
        const target = `sid:${row.sid}`;
        const uses = this.usesBySid.get(row.sid) ?? [];
        const evidence: EvidenceRef[] = patternHits.map((h) => ({ ref: target, role: "match", span: h.span, patternId }));
        if (uses.length === 0) {
          evidence[0] = { ...evidence[0]!, note: "no use sites in xref" };
        } else {
          for (const u of uses) evidence.push({ ref: `fn:${u.fn}`, role: "use-site", useRole: u.role, n: u.n });
        }
        const claim = `candidate ${CLAIM_LABELS[patternId] ?? patternId} (pattern ${patternId}, tier ${tier})${isTruncated ? " — head-only scan; retrieve via query string <sid> --full" : ""}`;
        const severity = SEVERITY_BY_TIER[tier];
        const ctx = { tier, patternSetVersion: PATTERN_SET_VERSION, patternId } as const;

        const active = this.store.allFindings().find((f) => f.active && f.target === target && f.patternId === patternId);
        if (active) {
          if (this.store.statusOf(active.rid) === "refuted") {
            skippedRefuted++;
            continue;
          }
          const sameContent = findingContentKey(active.claim, active.severity, active.evidence, active.ctx) === findingContentKey(claim, severity, evidence, ctx);
          if (sameContent) continue; // §6 idempotence: no supersede churn.
        }

        scanId++;
        this.store.addFinding(
          {
            target,
            claim,
            severity,
            evidence,
            patternId,
            prov: { source: "tool", who: "secrets-indexer", run: `scan:${this.bundleHash8}:${PATTERN_SET_VERSION}:${this.nextRun}:${scanId}` },
            ctx: ctx as unknown as import("../project/schema.ts").CtxSnapshot,
          },
          resolver,
        );
        newCount++;
      }
    }
    this.nextRun++;

    this.saveStore();
    this.saveScanState(state);

    return { new: newCount, cached: cachedCount, total: this.rows.length, skippedRefuted, wallTimeMs: Date.now() - start };
  }

  private rowsOf(): readonly FindingRow[] {
    return this.store
      .allFindings()
      .filter((f) => f.active)
      .map((f) => ({
        id: f.rid,
        kind: "finding" as const,
        target: f.target,
        status: this.store.statusOf(f.rid),
        severity: f.severity,
        evidence: f.evidence,
        prov: f.prov,
        ctx: f.ctx as FindingRow["ctx"],
      }));
  }

  /** §5 `secrets list` — capped at 50 rows (no truncation-marker row: caller
   *  reads a `.length===50` short read as "there may be more", spec 10 §3.1
   *  style). */
  list(q?: { readonly category?: string; readonly tier?: Tier }): readonly FindingRow[] {
    let rows = this.rowsOf();
    if (q?.tier !== undefined) rows = rows.filter((r) => r.ctx.tier === q.tier);
    if (q?.category !== undefined) rows = rows.filter((r) => r.ctx.patternId !== undefined && CLAIM_LABELS[r.ctx.patternId] !== undefined);
    return rows.slice(0, 50);
  }

  /** §5 `secrets report` — <=60 lines, candidate language only, matched text
   *  never rendered (evidence carries a span, never the value, §4.2/§10) so
   *  the >8-char quoting cap is structurally satisfied, not just checked. */
  report(): string[] {
    const rows = this.rowsOf();
    const tierCounts: Record<Tier, number> = { A: 0, B: 0, C: 0 };
    for (const r of rows) if (r.ctx.tier !== undefined) tierCounts[r.ctx.tier]++;
    const lines: string[] = [];
    lines.push(`secrets report — ${rows.length} open finding(s), pattern-set ${PATTERN_SET_VERSION}`);
    lines.push(`tier A:${tierCounts.A} B:${tierCounts.B} C:${tierCounts.C}`);
    const top = rows.slice(0, 10);
    for (const r of top) {
      lines.push(`#${r.id} ${r.ctx.tier ?? "-"} ${r.severity} ${r.target} uses:${r.evidence.filter((e) => e.role === "use-site").length} ${r.ctx.patternId ?? ""}`);
    }
    if (rows.length > top.length) lines.push(`… ${rows.length - top.length} more`);
    return lines.length <= 60 ? lines : [...lines.slice(0, 59), `… ${lines.length - 59} more`];
  }

  /** §3.3/§5 network surface — DEFERRED (module header): tag categories
   *  (`endpoint`) are not yet persisted pending the spec-11 `TAGS` taxonomy
   *  landing (owned by a concurrent agent on `src/project/**`), so there is
   *  no on-disk source of truth for this view yet. Empty, not wrong. */
  hosts(): readonly { readonly host: string; readonly paths: number; readonly fns: number }[] {
    return [];
  }

  paths(_host: string): readonly { readonly path: string; readonly fn: number }[] {
    return [];
  }
}
