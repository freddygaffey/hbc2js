// src/fuzzgen/minimise.ts — docs/specs/09-fuzzing.md §1.4 step 2.
//
// Seeded delta-debugging at statement granularity (ddmin over lines — the
// generator/mutator both emit one statement per line, including inside
// blocks) followed by a lighter expression-granularity pass that shrinks
// remaining numeric literals toward 0. A reduction step is kept only if the
// reduced program still reproduces the same signature (`reproduces`
// callback — true iff the candidate still triggers it). Idempotent: running
// minimise on an already-minimal program returns it unchanged.
export type Reproduces = (program: string) => boolean;

function linesOf(program: string): string[] {
  return program.split("\n");
}

/** Classic ddmin: repeatedly try removing ever-smaller contiguous chunks of
 *  lines, keeping a removal only if the remainder still reproduces. */
function ddminLines(lines: readonly string[], reproduces: Reproduces): string[] {
  let current = [...lines];
  let chunkSize = Math.max(1, Math.floor(current.length / 2));
  while (chunkSize >= 1) {
    let removedAny = false;
    let i = 0;
    while (i < current.length) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunkSize)];
      if (candidate.length > 0 && reproduces(candidate.join("\n"))) {
        current = candidate;
        removedAny = true;
        // Do not advance i — the next chunk has shifted into position i.
      } else {
        i += chunkSize;
      }
    }
    if (!removedAny) chunkSize = Math.floor(chunkSize / 2);
  }
  return current;
}

/** Shrinks standalone numeric literals in each surviving line toward 0,
 *  keeping a shrink only if reproduction still holds (expression-granularity
 *  pass). */
function shrinkLiterals(lines: readonly string[], reproduces: Reproduces): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!.match(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g);
    if (m === null) continue;
    let line = out[i]!;
    for (const num of new Set(m)) {
      if (num === "0") continue;
      const attempt = line.replace(new RegExp(`(?<![\\w.])${num.replace(/[.]/g, "\\.").replace(/^-/, "-?")}(?![\\w.])`, "g"), "0");
      const candidateLines = [...out.slice(0, i), attempt, ...out.slice(i + 1)];
      if (reproduces(candidateLines.join("\n"))) {
        line = attempt;
      }
    }
    out[i] = line;
  }
  return out;
}

/** Minimises `program` toward a smaller program that still `reproduces` the
 *  same signature. Guarantees: (a) the result reproduces, (b) its statement
 *  (line) count is <= the input's, (c) idempotent — minimising an already-
 *  minimal program returns it unchanged. Caller passes an input that itself
 *  reproduces (verified by the caller before calling minimise). */
export function minimise(program: string, reproduces: Reproduces): string {
  const lines = linesOf(program);
  const reduced = ddminLines(lines, reproduces);
  const shrunk = shrinkLiterals(reduced, reproduces);
  return shrunk.join("\n");
}
