// Orphan detection — docs/specs/11-project-store.md §2.5, §3.3, §7 step 6.
//
// Policy (§2.5, reviewer edit E1): a record's `target` is resolved against
// the CURRENT artifact index on every read — never cached, never a mutation
// of the stored line (append-only holds). A target that no longer resolves
// (the classic case: a re-decompile of DIFFERENT bytes, `fnIndex` not stable
// across versions — spec 10 §6) makes the record `orphaned`, live-computed,
// flag-never-drop: the record itself is untouched on disk, it is only
// EXCLUDED from active/`for-fn` reads and surfaced by `project orphans`
// (§3.1) with its write-time `ctx` snapshot (§2.1) for P2.5's re-binder.
//
// Reviewer edit E4 (§7 step 6's reuse cell): orphan detection needs only
// step-2 io's record shapes + an id-in-index lookup against `ArtifactService`
// — NOT step 4's finding-evidence resolver (`evidence-resolver.ts`), even
// though both parse the same small `fn:`/`reg:`/`env:`/`sid:`/`mod:` target
// vocabulary (`src/name-overlay/id.ts`'s `bindingKey` shape). This module is
// therefore self-contained: no import from `evidence-resolver.ts`, so step 6
// stays dependent on step 2 + `ArtifactService` only, as the reuse column
// promises.
import type { CtxSnapshot } from "./schema.ts";

/** The three existence checks an orphan lookup needs — the same shape
 *  `ArtifactService` exposes (`hasFn`/`hasString`/`hasModule`), kept as a
 *  narrow local interface so this module has no import edge onto
 *  `evidence-resolver.ts`'s `ArtifactExistenceCheck` (see module header). */
export interface TargetIndexCheck {
  readonly hasFn: (fn: number) => boolean;
  readonly hasString: (sid: number) => boolean;
  readonly hasModule: (id: number) => boolean;
}

/** True iff `target` (a `fn:N` / `reg:F:R` / `env:F:S` / `sid:N` / `mod:N`
 *  binding-id/target string, §1's shared id vocabulary) still resolves
 *  against `index`. `reg:`/`env:` resolve on their OWNING function — the
 *  store carries no per-register catalogue, same coarsest-honest-signal
 *  reasoning `ArtifactEvidenceResolver` uses for evidence refs (§4.1). An
 *  unrecognised or malformed target is unresolvable, never guessed. */
export function targetResolves(target: string, index: TargetIndexCheck): boolean {
  const m = /^([a-z]+):(.+)$/.exec(target);
  if (m === null) return false;
  const kind = m[1];
  const body = m[2] as string;
  switch (kind) {
    case "fn": {
      const n = Number(body);
      return Number.isInteger(n) && index.hasFn(n);
    }
    case "reg":
    case "env": {
      const fn = Number(body.split(":")[0]);
      return Number.isInteger(fn) && index.hasFn(fn);
    }
    case "sid": {
      const n = Number(body);
      return Number.isInteger(n) && index.hasString(n);
    }
    case "mod": {
      const n = Number(body);
      return Number.isInteger(n) && index.hasModule(n);
    }
    default:
      return false;
  }
}

/** §2.5's live orphan predicate: the inverse of `targetResolves`, named for
 *  call-site readability at every exclusion point (`ProjectService`'s reads)
 *  and at `project orphans`/`stat`'s inclusion point. */
export function isOrphaned(target: string, index: TargetIndexCheck): boolean {
  return !targetResolves(target, index);
}

/** One orphaned record as `project orphans` (§3.1) reports it: which record
 *  (`kind`+`rid`, so the answer stays a stable pointer, never the whole
 *  record body — token-bounded per §3.1), its vanished `target`, and its
 *  write-time `ctx` snapshot (§2.1/§2.5) — the only thing P2.5's re-binder
 *  has to work from once the artifact no longer carries `target`. */
export interface OrphanRow {
  readonly kind: string;
  readonly rid: string;
  readonly target: string;
  readonly ctx: CtxSnapshot;
}

/** The minimal shape `collectOrphans` needs from any record-type row —
 *  every §2.1 envelope already carries all four fields. */
export interface OrphanCandidate {
  readonly kind: string;
  readonly rid: string;
  readonly target: string;
  readonly active: boolean;
  readonly ctx: CtxSnapshot;
}

/** Scans ACTIVE records only (§2.5: a superseded/reverted record was never
 *  "live" to begin with, orphan status is about live code, not history) and
 *  returns one `OrphanRow` per record whose target no longer resolves,
 *  sorted by `(target, rid)` — the same sort every other JSONL/query surface
 *  uses (§2.2/§3.1), so `project orphans`' output is stable and diffable.
 *  Never drops a record — an orphaned line is reported here, never removed
 *  from its source array (flag-never-drop, §2.5). */
export function collectOrphans(records: readonly OrphanCandidate[], index: TargetIndexCheck): OrphanRow[] {
  const rows = records
    .filter((r) => r.active && isOrphaned(r.target, index))
    .map((r): OrphanRow => ({ kind: r.kind, rid: r.rid, target: r.target, ctx: r.ctx }));
  rows.sort((a, b) => a.target.localeCompare(b.target) || a.rid.localeCompare(b.rid));
  return rows;
}
