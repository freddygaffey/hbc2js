// tools/passes/iife-overlap.ts -- classify spec 27's `overlapping statement
// ranges` refusal (docs/specs/passes/27-iife-reconstruct.md sections 4 and 7,
// 757 environments on react-navigation-example-0.85.3) by WHY the ranges of a
// group of sibling environments interleave.
//
// Why a tool and not a diagnostic: the emitter only reports one summary line
// per function, and the interesting quantity is per GROUP of overlapping
// environments -- how many are merely scheduled apart by `hermesc -O` (the
// regrouping of `src/emit/iife-group.ts` reorders those into one block each),
// how many are strictly NESTED ranges, and, for the rest, which statement
// shape blocks the reordering. It spies on `grouping.plan` for the duration of
// one whole-bundle decompile, the same way tools/passes/ctor-this-refusals.ts
// spies on `ctorThis.match`.
//
//   node --max-old-space-size=8192 tools/passes/iife-overlap.ts <bundle.hbc>
//
// Output is aggregate only (counts per class/shape); it never prints a
// bundle-derived identifier, so its output is safe to quote in docs.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupMember, GroupOutcome } from "../../src/emit/iife-group.ts";
import { grouping } from "../../src/emit/iife-group.ts";
import { splitProject } from "../../src/split/index.ts";

export interface GroupRecord {
  /** "PLAN" when the group can be reordered into one block per environment,
   *  otherwise the refusal reason `planGrouping` gave. */
  readonly outcome: string;
  /** Environments in the group (each one is an `overlapping statement ranges`
   *  refusal without the regrouping). */
  readonly envs: number;
  /** Some member's range strictly contains another's: a nested IIFE shape
   *  rather than two schedules interleaved. */
  readonly nested: boolean;
  /** Every member's range starts and ends inside every other's: total overlap. */
  readonly interleaved: boolean;
}

function classifyShape(members: readonly GroupMember[]): { nested: boolean; interleaved: boolean } {
  let nested = false;
  let interleaved = false;
  for (const a of members) {
    for (const b of members) {
      if (a === b) continue;
      if (a.from < b.from && b.to < a.to) nested = true;
      else if (a.from < b.from && a.to < b.to && b.from <= a.to) interleaved = true;
    }
  }
  return { nested, interleaved };
}

/** Runs one whole-bundle decompile with passes on, spying on the grouping. */
export function classify(bytes: Uint8Array, moduleName: string): GroupRecord[] {
  const records: GroupRecord[] = [];
  const original = grouping.plan;
  grouping.plan = (body, members, mentions): GroupOutcome => {
    const outcome = original(body, members, mentions);
    const shape = classifyShape(members);
    records.push({ outcome: "plan" in outcome ? "PLAN" : outcome.reason, envs: members.length, ...shape });
    return outcome;
  };
  try {
    splitProject(bytes, { moduleName, passes: {} });
  } finally {
    grouping.plan = original;
  }
  return records;
}

function tally(rows: readonly GroupRecord[]): string {
  const byOutcome = new Map<string, { groups: number; envs: number }>();
  for (const r of rows) {
    const cell = byOutcome.get(r.outcome) ?? { groups: 0, envs: 0 };
    cell.groups++;
    cell.envs += r.envs;
    byOutcome.set(r.outcome, cell);
  }
  const out = ["", "| outcome | groups | environments |", "|---|---|---|"];
  for (const [k, v] of [...byOutcome.entries()].sort((a, b) => b[1].envs - a[1].envs || a[0].localeCompare(b[0]))) {
    out.push(`| \`${k}\` | ${v.groups} | ${v.envs} |`);
  }
  const sum = (f: (r: GroupRecord) => boolean): string => {
    const sel = rows.filter(f);
    return `${sel.length} group(s), ${sel.reduce((n, r) => n + r.envs, 0)} environment(s)`;
  };
  out.push("");
  out.push(`total: ${sum(() => true)}`);
  out.push(`planned (reordering proved): ${sum((r) => r.outcome === "PLAN")}`);
  out.push(`with a strictly nested range: ${sum((r) => r.nested)}`);
  out.push(`with a crossing (interleaved) range: ${sum((r) => r.interleaved)}`);
  return out.join("\n");
}

function main(argv: readonly string[]): void {
  const bundle = argv[0];
  if (bundle === undefined) throw new Error("usage: iife-overlap.ts <bundle.hbc>");
  const records = classify(new Uint8Array(readFileSync(bundle)), basename(bundle));
  process.stdout.write(`# spec 27 overlapping-range classification -- ${basename(bundle)}\n`);
  process.stdout.write(tally(records) + "\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e: unknown) {
    process.stderr.write(`iife-overlap: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  }
}
