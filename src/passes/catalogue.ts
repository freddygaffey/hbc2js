// PL-06 (docs/specs/07-pass-ladder.md §8): every registered pass declares the
// docs/LOWERING-CATALOGUE.md rows it implements, and the catalogue is the
// source of truth for whether a row may have a pass at all. A row whose status
// column is ⛔ (inferred) fails the gate; so does "✅ single-version", which the
// catalogue's own confidence key says to "treat as ⚠️, not ✅, for that
// purpose"; a missing row, or a pass declaring no row at all, fails too.
import type { Pass } from "./types.ts";

export interface CatalogueRow {
  readonly row: number;
  readonly idiom: string;
  readonly status: string;
}

/** Parse the `## Index` table: `| # | Idiom | … | Confidence | Notes |`. */
export function parseCatalogueIndex(markdown: string): Map<number, CatalogueRow> {
  const out = new Map<number, CatalogueRow>();
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^\|\s*#\s*\|/.test(l));
  if (start < 0) return out;
  const header = lines[start]!.split("|").map((c) => c.trim());
  const statusCol = header.findIndex((c) => /^(confidence|status)$/i.test(c));
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    const row = Number(cells[1]);
    if (!Number.isInteger(row)) continue;
    out.set(row, { row, idiom: cells[2] ?? "", status: cells[statusCol] ?? "" });
  }
  return out;
}

/** Problems, one line each; empty means PL-06 holds. */
export function checkCatalogue(passes: readonly Pass[], markdown: string): string[] {
  const rows = parseCatalogueIndex(markdown);
  const problems: string[] = [];
  for (const p of passes) {
    if (p.catalogue.length === 0) problems.push(`pass "${p.name}" declares no catalogue row`);
    for (const n of p.catalogue) {
      const row = rows.get(n);
      if (row === undefined) problems.push(`pass "${p.name}" declares catalogue row ${n}, which does not exist`);
      else if (!row.status.includes("✅") || row.status.includes("⛔") || /single-version/i.test(row.status)) problems.push(`pass "${p.name}" declares catalogue row ${n} ("${row.idiom}") whose status is "${row.status}", not "✅ verified"`);
    }
  }
  return problems;
}
