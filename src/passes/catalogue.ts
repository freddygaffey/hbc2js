// PL-06 (docs/specs/07-pass-ladder.md §8): every registered pass declares the
// docs/LOWERING-CATALOGUE.md rows it implements, and the catalogue is the
// source of truth for whether a row may have a pass at all. A row whose status
// column is ⛔ (inferred) fails the gate; so does "✅ single-version", which the
// catalogue's own confidence key says to "treat as ⚠️, not ✅, for that
// purpose"; a missing row, or a pass declaring no row at all, fails too.
import type { Pass } from "./types.ts";

export interface CatalogueRow {
  readonly row: number | string;
  readonly idiom: string;
  readonly status: string;
}

/**
 * Parse the `## Index` table (`| # | Idiom | … | Confidence | Notes |`) and,
 * per `docs/specs/passes/01-framework-fixes.md` F2, the `## Readability rows
 * (PL-06)` table, which has the same columns but `R\d+`-prefixed keys (a
 * readability rung recognises no Hermes idiom, so it cannot cite a numbered
 * one). Both tables land in one map: `Pass.catalogue` may name either kind of
 * key, and `checkCatalogue` applies the identical confidence rule to both.
 */
export function parseCatalogueIndex(markdown: string): Map<number | string, CatalogueRow> {
  const out = new Map<number | string, CatalogueRow>();
  const lines = markdown.split("\n");
  for (const start of lines.reduce<number[]>((acc, l, i) => (/^\|\s*#\s*\|/.test(l) ? [...acc, i] : acc), [])) {
    const header = lines[start]!.split("|").map((c) => c.trim());
    const statusCol = header.findIndex((c) => /^(confidence|status)$/i.test(c));
    for (let i = start + 2; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith("|")) break;
      const cells = line.split("|").map((c) => c.trim());
      const cell = cells[1] ?? "";
      const row: number | string = /^R\d+$/.test(cell) ? cell : Number(cell);
      if (typeof row === "number" && !Number.isInteger(row)) continue;
      out.set(row, { row, idiom: cells[2] ?? "", status: cells[statusCol] ?? "" });
    }
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
