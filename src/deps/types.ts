// src/deps/types.ts — the report-level dependency tier a `DepsReport` entry
// is filed under (D17a, extended 2026-08-30 with `hint` per the overseer's
// decision after `docs/reviews/deps-v1.md`). Distinct from `ConfidenceTier`
// (`src/deps/match.ts`), which scores a single signature-DB match; this is
// the tier a *reported dependency* ends up in once match/guess/confirm and
// the precision rules (`docs/reviews/deps-v1.md`, `src/deps/report.ts`) have
// all weighed in.
//
//   confirmed — db-match "high" tier, or `--confirm` fingerprinted a real
//               npm build against the target. Written into `package.json`;
//               counts toward `attribution.percentAttributed`.
//   guessed   — >=2 independent evidence kinds (`src/deps/guess.ts`),
//               aggregate confidence >= `GUESS_CONFIDENCE_FLOOR`. Counts
//               toward attribution; never written into `package.json`.
//   hint      — exactly one evidence kind, and only when that kind is
//               high-specificity: a curated `NativeModules`/
//               `TurboModuleRegistry` name, a package-name string literal
//               that itself carries a version, or a curated API-host
//               constant (`isHintEligibleEvidence`, `src/deps/guess.ts`).
//               Never a bare npm-search hit, an APK hint, or a
//               dependency-edge alone — none of those are specific enough
//               to stand without corroboration. Reported for visibility
//               only: never in `package.json`, never counted in
//               `attribution.percentAttributed`.
export type DepTier = "confirmed" | "guessed" | "hint";

const TIER_RANK: Readonly<Record<DepTier, number>> = { confirmed: 2, guessed: 1, hint: 0 };

/** Higher rank first. `report.ts` never lets one package land in more than
 *  one tier (a confirmed or guessed package is excluded from the tiers below
 *  it before this would matter), but keeping the ordering in one named place
 *  avoids re-deriving it if a caller ever needs to sort mixed-tier rows. */
export function tierRank(tier: DepTier): number {
  return TIER_RANK[tier];
}
