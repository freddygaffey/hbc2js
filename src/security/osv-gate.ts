// src/security/osv-gate.ts — Lane O's two-key claim/candidate classifier
// (spec 13 `docs/specs/13-reuse-validation.md` §3.2, "The false-attribution
// gate — claim vs candidate"). Pure: takes an already-computed `DepsReport`
// (`src/deps/report.ts`, never re-derived here — §1 point 2's binding reuse
// rule) and a package name, returns which tier that package's identity+
// version evidence clears. No network, no OSV/advisory knowledge at all —
// the OSV adapter (`tools/security/osv-adapter.ts`) is the only caller that
// knows what an advisory is; this module only answers "how sure are we this
// app really has <pkg>@<version>". T2 (`tests/security/t2-two-key-gate.test.ts`)
// exercises this directly against fabricated `DepsReport`s.
//
// Two keys, both required for claim tier (§3.2):
//   1. Identity key — `confirmedDeps` tier "high", OR a `guessedDeps` entry
//      with aggregated confidence >= 0.75 AND >= 2 independent evidence
//      kinds (the DEPS.md guess-listing floor is 0.5/1-kind-if-hint-eligible;
//      the CVE bar is deliberately higher, spec text explicit on this).
//   2. Version key — the version is *directly* evidenced: an exact-hash
//      match pinned to that version (`ConfirmedDep.source==="db-match"`, or
//      `"confirmed"` with `versionEvidence!=="date-inferred"`), or a
//      `name@version`-shaped string literal in the bundle (`hintedDeps`,
//      DEPS.md hint tier). A version resolved by nearest-npm-release-by-date
//      (`versionEvidence==="date-inferred"`) is NOT direct evidence.
//
// Both keys -> "claim". Identity only -> "candidate" (severity capped at
// "med" by the caller, per spec text — this module only reports the tier,
// severity mapping lives in the adapter's fixed table). Neither -> "none":
// the caller must not synthesize a finding at all.
import type { DepsReport, GuessedDep } from "../deps/report.ts";

/** §3.2's guessed-identity bar — deliberately above `GUESS_CONFIDENCE_FLOOR`
 *  (0.5, `src/deps/report.ts`) used for merely *listing* a guess. */
export const MIN_GUESS_IDENTITY_CONFIDENCE = 0.75;
export const MIN_GUESS_IDENTITY_EVIDENCE_KINDS = 2;

export type IdentityBasis = "matched-high" | "guessed-strong" | null;
export type VersionBasis = "exact-hash" | "confirmed-exact" | "hint-literal" | null;
export type GateTier = "claim" | "candidate" | "none";

export interface DependencyGate {
  readonly package: string;
  readonly hasIdentity: boolean;
  readonly identityBasis: IdentityBasis;
  /** Best version we have for this package, direct or not — a candidate-
   *  tier finding may still want to name a version in its "possibly in
   *  advisory range of" text even though it isn't proof. `null` when no
   *  evidence carried a version at all. */
  readonly version: string | null;
  readonly hasDirectVersion: boolean;
  readonly versionBasis: VersionBasis;
  readonly tier: GateTier;
}

/** `GuessedDep.evidence` (`src/deps/report.ts`) is a `Set` of
 *  `"<kind>: <detail>"` strings, one per distinct (kind, detail) pair
 *  (`buildReport`'s `addGuess`) — the kind prefix is exactly the
 *  `Evidence["kind"]` value (`native-module`/`url-host`/`package-name-string`/
 *  `dependency-edge`/`npm-search`/`apk`, `src/deps/guess.ts`). Reconstructing
 *  the kind SET from these strings (rather than requiring a new field on
 *  `GuessedDep`) keeps this module additive over the existing report shape. */
function evidenceKindsOf(dep: GuessedDep): ReadonlySet<string> {
  return new Set(dep.evidence.map((e) => (e.includes(":") ? e.slice(0, e.indexOf(":")).trim() : e.trim())));
}

export interface GateOptions {
  /** R-T demotion tripwire (spec 13 §13 ruling 2 / edit R-T): "any measured
   *  claim-tier misattribution anywhere demotes guessed-identity (non-High)
   *  claims to candidate tier repo-wide until a review reinstates them."
   *  When true, a package whose identity key came from `guessed-strong`
   *  (never from a real `matchedDeps` High tier — that identity is not a
   *  guess) is capped at candidate tier regardless of its version key.
   *  Wired by the caller from `tools/security/osv-demotion.json`
   *  (`isGuessedClaimDemotionActive`, below) — this module stays pure and
   *  takes the flag as an explicit parameter, no I/O of its own. */
  readonly demoteGuessedIdentityClaims?: boolean;
}

/** The two-key gate for one package name against an already-computed
 *  `DepsReport`. Does not know or care about advisories — see module
 *  header. */
export function gateDependency(report: DepsReport, pkgName: string, opts: GateOptions = {}): DependencyGate {
  const matched = report.confirmedDeps.find((d) => d.package === pkgName && d.confidence === "high");
  const hinted = report.hintedDeps.find((d) => d.package === pkgName && d.version !== null);

  let hasIdentity = false;
  let identityBasis: IdentityBasis = null;
  let version: string | null = null;
  let hasDirectVersion = false;
  let versionBasis: VersionBasis = null;

  if (matched !== undefined) {
    hasIdentity = true;
    identityBasis = "matched-high";
    version = matched.version;
    // `versionEvidence` undefined (older/hand-built reports) is treated as
    // exact-hash for a `db-match` source (that source is never anything
    // else, see `src/deps/report.ts`'s `ConfirmedDep.versionEvidence` doc)
    // and as non-direct for `confirmed` (honest: we don't know).
    const direct = matched.source === "db-match" ? matched.versionEvidence !== "date-inferred" : matched.versionEvidence === "exact-hash";
    if (direct) {
      hasDirectVersion = true;
      versionBasis = matched.source === "db-match" ? "exact-hash" : "confirmed-exact";
    }
  } else {
    const guessed = report.guessedDeps.find((d) => d.package === pkgName);
    if (guessed !== undefined) {
      const kinds = evidenceKindsOf(guessed);
      if (guessed.confidence >= MIN_GUESS_IDENTITY_CONFIDENCE && kinds.size >= MIN_GUESS_IDENTITY_EVIDENCE_KINDS) {
        hasIdentity = true;
        identityBasis = "guessed-strong";
        version = guessed.version;
      }
    }
  }

  // A name@version string literal is direct version evidence independent of
  // where identity came from (§3.2's version key is a standalone clause).
  if (!hasDirectVersion && hinted !== undefined) {
    hasDirectVersion = true;
    versionBasis = "hint-literal";
    version = version ?? hinted.version;
  }

  if (opts.demoteGuessedIdentityClaims === true && identityBasis === "guessed-strong") {
    hasDirectVersion = false; // forces candidate tier below regardless of version key
  }

  const tier: GateTier = !hasIdentity ? "none" : hasDirectVersion ? "claim" : "candidate";
  return { package: pkgName, hasIdentity, identityBasis, version, hasDirectVersion, versionBasis, tier };
}

/** Every package name worth gating: anything with a confirmed OR guessed
 *  entry (a hint-only package with no identity signal never reaches "none"
 *  vs "candidate" — it's correctly `hasIdentity:false` either way, but there
 *  is no point asking; §3.2 "a Low/hint dep never generates CVE noise"). */
export function packagesToGate(report: DepsReport): readonly string[] {
  const names = new Set<string>();
  for (const d of report.confirmedDeps) names.add(d.package);
  for (const d of report.guessedDeps) names.add(d.package);
  return [...names];
}
