// expr-rebuild's per-register position index (`src/passes/expr-rebuild/
// stmt-index.ts`, perf part 6 of docs/BUGS.md's "452 s / 946 s" superlinear
// row) answers `nextRelevant`/`anyPassThroughBetween` from sorted position
// lists instead of walking the statements in between, and *derives* those
// lists across a splice rather than rebuilding them.
//
// Both halves are semantics-critical: a wrong answer silently changes which
// fold sites `classifySite` accepts. So this file is a differential against
// the brute-force scan the index replaced - written here, over the same
// exported `stmtInterest` facts, so the two implementations share nothing but
// those facts.
//
// The index only exists for lists at or above `INDEX_MIN_LENGTH` (128), so
// every case below is run at a length on each side of that threshold: the
// short lists prove the fallback scan still agrees, the long ones prove the
// index does.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { anyPassThroughBetween, nextRelevant, noteStmtIndexSplice, stmtInterest } from "../../../src/passes/expr-rebuild/stmt-index.ts";

/** Deterministic PRNG (mulberry32) - a differential test that only fails on
 *  some runs is worse than no test. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGS = ["r0", "r1", "r2", "r7", "r13"] as const;

function randomStmt(r: () => number, n: number): Stmt {
  const reg = REGS[Math.floor(r() * REGS.length)]!;
  const pick = r();
  if (pick < 0.3) return { k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } };
  if (pick < 0.6) return { k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg)] } };
  if (pick < 0.75) return { k: "expr", expr: { k: "call", callee: id("sink"), args: [lit(String(n))] } };
  if (pick < 0.85) return { k: "if", test: id(reg), then: [{ k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg)] } }], else: [] };
  if (pick < 0.95) return { k: "while", label: null, test: id("cond"), body: [{ k: "break", label: null }] };
  return { k: "break", label: null };
}

function randomList(r: () => number, len: number): Stmt[] {
  const out: Stmt[] = [];
  for (let n = 0; n < len; n++) out.push(randomStmt(r, n));
  return out;
}

/** The implementation the index replaced, kept here as the oracle. */
function scanNextRelevant(list: readonly Stmt[], reg: string, from: number): number {
  for (let m = Math.max(from, 0); m < list.length; m++) {
    const it = stmtInterest(list[m]!);
    if (it.jump || it.regs.has(reg)) return m;
  }
  return list.length;
}

function scanAnyPassThrough(list: readonly Stmt[], from: number, to: number): boolean {
  for (let m = Math.max(from, 0); m < Math.min(to, list.length); m++) if (stmtInterest(list[m]!).passThrough) return true;
  return false;
}

function agreesEverywhere(list: readonly Stmt[], label: string): void {
  for (const reg of [...REGS, "r99"]) {
    for (let from = 0; from <= list.length + 1; from++) {
      assert.equal(nextRelevant(list, reg, from), scanNextRelevant(list, reg, from), `${label}: nextRelevant(${reg}, ${from})`);
    }
  }
  for (let from = 0; from <= list.length; from += 3) {
    for (const span of [0, 1, 5, 40, list.length]) {
      assert.equal(anyPassThroughBetween(list, from, from + span), scanAnyPassThrough(list, from, from + span), `${label}: anyPassThroughBetween(${from}, ${from + span})`);
    }
  }
}

test("the position index answers nextRelevant/anyPassThroughBetween exactly as the scan it replaced", () => {
  for (const len of [40, 130, 400]) {
    const r = rng(0x51de + len);
    agreesEverywhere(randomList(r, len), `fresh list of ${len}`);
  }
});

/**
 * The derivation path: `check.ts` hands the index from `before` to `after`
 * given that `after` is `before` with `[at, hiBefore)` replaced by `[at,
 * hiAfter)` and every other position the *same object*. Each step below
 * builds exactly such an `after` (the three shapes `expr-rebuild`'s rewriter
 * produces: delete one statement, replace one statement in place, and delete
 * one while substituting into a later one), notes the splice, and re-checks
 * every query against the brute-force scan on the derived list. Errors
 * compound - step `n + 1` derives from step `n`'s index - so a single wrong
 * shift anywhere in the chain is caught.
 */
test("the position index survives a chain of splices with the same answers as a rebuild", () => {
  for (const len of [40, 130, 400]) {
    const r = rng(0xd0e + len);
    let cur: readonly Stmt[] = randomList(r, len);
    agreesEverywhere(cur, `chain start, len ${len}`);
    for (let step = 0; step < 60 && cur.length > 8; step++) {
      const shape = Math.floor(r() * 3);
      const at = Math.floor(r() * (cur.length - 4));
      let next: readonly Stmt[];
      let hiBefore: number;
      let hiAfter: number;
      if (shape === 0) {
        // R1c / pure R1b: the store at `at` disappears.
        next = [...cur.slice(0, at), ...cur.slice(at + 1)];
        hiBefore = at + 1;
        hiAfter = at;
      } else if (shape === 1) {
        // impure R1b: the store at `at` becomes its own remnant.
        next = [...cur.slice(0, at), randomStmt(r, step), ...cur.slice(at + 1)];
        hiBefore = at + 1;
        hiAfter = at + 1;
      } else {
        // R1a: the store at `at` disappears and the read at `j` is rewritten.
        const j = Math.min(at + 1 + Math.floor(r() * 4), cur.length - 1);
        const folded = [...cur.slice(at + 1, j), randomStmt(r, step)];
        next = [...cur.slice(0, at), ...folded, ...cur.slice(j + 1)];
        hiBefore = j + 1;
        hiAfter = j;
      }
      noteStmtIndexSplice(cur, next, at, hiBefore, hiAfter);
      cur = next;
      agreesEverywhere(cur, `len ${len}, step ${step}, shape ${shape}`);
    }
  }
});
