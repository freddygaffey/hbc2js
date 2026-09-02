// src/fuzzgen/seedRange.ts — docs/specs/09-fuzzing.md §1.5.iv seed discipline,
// enforced programmatically rather than left to convention (per the launch
// brief): tuning/fix iterations may only use seeds in the campaign's work
// range `[S, S+80000)`; the exit-criterion measurement uses the disjoint
// evaluation range `[S+900000, S+902000)`, run once, never re-run during
// tuning.
export type SeedRangeKind = "work" | "eval";

export interface SeedRange {
  readonly kind: SeedRangeKind;
  readonly start: number;
  readonly end: number; // exclusive
}

const WORK_SPAN = 80_000;
const EVAL_OFFSET = 900_000;
const EVAL_SPAN = 2_000;

export function workRange(seedBase: number): SeedRange {
  return { kind: "work", start: seedBase, end: seedBase + WORK_SPAN };
}

export function evalRange(seedBase: number): SeedRange {
  return { kind: "eval", start: seedBase + EVAL_OFFSET, end: seedBase + EVAL_OFFSET + EVAL_SPAN };
}

export function inRange(seed: number, range: SeedRange): boolean {
  return seed >= range.start && seed < range.end;
}

/** Two ranges (possibly from different campaigns/seed bases) overlap. Used
 *  both by a unit test (work/eval never overlap for the same base) and by
 *  the driver/scoreboard to flag a campaign that re-ran evaluation seeds
 *  during tuning (§1.5.iv: "evaluation-range seeds are never re-run"). */
export function rangesOverlap(a: SeedRange, b: SeedRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Given every seed range a report has ever recorded (this run plus prior
 *  runs the caller supplies), true iff any eval-range run reused seeds an
 *  earlier work-range (tuning) run already touched, or vice versa — the
 *  violation the scoreboard is supposed to flag (§1.5.iv). */
export function hasWorkEvalOverlap(ranges: readonly SeedRange[]): boolean {
  const work = ranges.filter((r) => r.kind === "work");
  const evalRanges = ranges.filter((r) => r.kind === "eval");
  return work.some((w) => evalRanges.some((e) => rangesOverlap(w, e)));
}
