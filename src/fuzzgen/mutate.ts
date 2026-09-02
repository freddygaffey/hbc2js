// src/fuzzgen/mutate.ts — docs/specs/09-fuzzing.md §1.2 mutation mode.
//
// Seed corpus = every fixture's `source.js` under tests/fixtures/constructs/
// (grows automatically as fixtures land). Operators applied here: var<->let
// conversion (D14-provocative loop-binding/TDZ semantics), numeric-literal
// perturbation across the semantic-fork values already enumerated in
// src/harness/fuzz.ts's CORPUS, and top-level statement duplication.
//
// Safety net: mutation is regex-based, not AST-based, so a mutated program is
// validated with `node --check` before being returned; on failure the
// pristine (unmutated) fixture source is returned instead — deterministic for
// the same seed, and guaranteed syntactically valid either way (T2(c)).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mulberry32 } from "./generate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "..", "..", "tests", "fixtures", "constructs");

let cachedCorpus: readonly string[] | undefined;

/** Every construct fixture's `source.js`, sorted for determinism. Exported
 *  so tests can assert against the real corpus size without duplicating the
 *  directory scan. */
export function corpusSources(): readonly string[] {
  if (cachedCorpus !== undefined) return cachedCorpus;
  if (!existsSync(CORPUS_DIR)) {
    cachedCorpus = [];
    return cachedCorpus;
  }
  const out: string[] = [];
  for (const name of readdirSync(CORPUS_DIR).sort()) {
    const p = join(CORPUS_DIR, name, "source.js");
    if (existsSync(p)) out.push(p);
  }
  cachedCorpus = out;
  return out;
}

// Semantic-fork literal values (subset of src/harness/fuzz.ts's CORPUS,
// reproduced as source text rather than imported — fuzz.ts's CORPUS holds
// runtime values, not source snippets).
const NUMERIC_FORKS = ["-0", "0", "1", "NaN", "Infinity", "-Infinity", "1e21", "0x10"];

function perturbNumericLiterals(src: string, rng: () => number): string {
  return src.replace(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g, (m) => (rng() < 0.3 ? NUMERIC_FORKS[Math.floor(rng() * NUMERIC_FORKS.length)]! : m));
}

function swapVarLet(src: string, rng: () => number): string {
  if (rng() < 0.5) return src.replace(/\bvar\b/g, "let");
  return src.replace(/\blet\b/g, "var");
}

/** Duplicates one top-level line (brace-balance-naive but safe: a duplicated
 *  whole line can only ever redeclare or re-execute, never break syntax on
 *  its own — the node --check safety net catches the rare cases where a
 *  redeclare is a SyntaxError, e.g. duplicate `const`). */
function duplicateTopLevelLine(src: string, rng: () => number): string {
  const lines = src.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return src;
  const i = Math.floor(rng() * lines.length);
  const line = lines[i]!;
  if (/\bconst\b/.test(line)) return src; // redeclare-unsafe, skip
  lines.splice(i, 0, line);
  return lines.join("\n");
}

function checkSyntax(src: string): boolean {
  const r = spawnSync(process.execPath, ["--check"], { input: src, encoding: "utf8" });
  return r.status === 0;
}

/** Mutation-mode program for `seed`: picks one corpus fixture and applies a
 *  deterministic sequence of safe mutations, falling back to the pristine
 *  fixture text if the mutated result fails `node --check`. */
export function mutateFromCorpus(seed: number): string {
  const corpus = corpusSources();
  const rng = mulberry32(seed);
  if (corpus.length === 0) return `print('no corpus fixtures found, seed ${seed}');\n`;
  const path = corpus[Math.floor(rng() * corpus.length)]!;
  const original = readFileSync(path, "utf8");
  let mutated = original;
  const ops = [perturbNumericLiterals, swapVarLet, duplicateTopLevelLine];
  for (const op of ops) {
    if (rng() < 0.6) mutated = op(mutated, rng);
  }
  return checkSyntax(mutated) ? mutated : original;
}
