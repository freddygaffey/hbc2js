// `registerUses`'s whole-function register counts (`src/passes/ast.ts`) are
// now (a) folded out of per-*statement* counts memoised on the statement's
// own identity, so an untouched statement is never re-walked in a later
// generation of a list, and (b) what `identUsesMany` answers from whenever
// every wanted name is a register name (perf part 7 of docs/BUGS.md's
// "452 s / 946 s" superlinear row; docs/reports/2026-09-08-perf7-uses.md).
//
// Both halves are semantics-critical: these counts decide `expr-rebuild`'s
// D-b ("written once, read exactly here"), `var-naming`'s per-site checker
// and a dozen `identUses(fnBody, rN)` guards, so a count that is stale by
// one silently changes which rewrites are accepted.
//
// This file is a differential against the walk the projection replaced. The
// oracle asks for the same register names *plus one non-register name*,
// which is the one condition (`followNested`) that forces `identUsesMany`
// down its original `countUses` path - so the two sides share no code below
// `countUses` itself, and the counts they report for a register name must
// agree exactly (a register is never credited a use inside a nested `func`
// frame either way; see `IdentUses.nested`).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { identUses, identUsesMany, noteRegisterUsesSplice, registerUses, stmtRegisterUses } from "../../../src/passes/ast.ts";

/** Deterministic PRNG (mulberry32), as in `stmt-index.test.ts`. */
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
/** Never a register name: forces the oracle's walk to follow nested bodies. */
const SENTINEL = "_e0_1";

function randomStmt(r: () => number, n: number): Stmt {
  const reg = REGS[Math.floor(r() * REGS.length)]!;
  const other = REGS[Math.floor(r() * REGS.length)]!;
  const pick = r();
  if (pick < 0.24) return { k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n)), id(other)] } } };
  if (pick < 0.44) return { k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg), id(other)] } };
  if (pick < 0.56) return { k: "init", kind: "let", name: reg, value: { k: "bin", op: "+", left: id(other), right: lit(String(n)) } };
  if (pick < 0.66) return { k: "expr", expr: { k: "call", callee: id("sink"), args: [lit(String(n))] } };
  if (pick < 0.76) return { k: "if", test: id(reg), then: [{ k: "expr", expr: { k: "call", callee: id("use"), args: [id(other)] } }], else: [{ k: "expr", expr: { k: "assign", target: id(other), value: id(reg) } }] };
  if (pick < 0.84) return { k: "while", label: null, test: id(reg), body: [{ k: "expr", expr: { k: "call", callee: id("use"), args: [id(other)] } }] };
  if (pick < 0.94) {
    // A separate register frame: a same-numbered register in here is a
    // different binding, so neither side may count it (`IdentUses.nested`).
    const inner: Stmt[] = [{ k: "expr", expr: { k: "assign", target: id(reg), value: id(other) } }, { k: "expr", expr: { k: "call", callee: id(SENTINEL), args: [id(reg)] } }];
    return { k: "expr", expr: { k: "call", callee: id("wrap"), args: [{ k: "func", name: null, params: [], body: inner }] } };
  }
  return { k: "break", label: null };
}

function randomList(r: () => number, len: number): Stmt[] {
  const out: Stmt[] = [];
  for (let n = 0; n < len; n++) out.push(randomStmt(r, n));
  return out;
}

/** The walk the projection replaced: `identUsesMany`'s `countUses` path,
 *  reached by including one non-register name in the query. */
function oracle(list: readonly Stmt[]): Map<string, { reads: number; writes: number; nested: number }> {
  const counts = identUsesMany(list, [...REGS, SENTINEL]);
  const out = new Map<string, { reads: number; writes: number; nested: number }>();
  for (const reg of REGS) {
    const u = counts.get(reg)!;
    out.set(reg, { reads: u.reads, writes: u.writes, nested: u.nested });
  }
  return out;
}

function agrees(list: readonly Stmt[], label: string, coldOrder = true): void {
  const expected = oracle(list);
  const many = identUsesMany(list, REGS);
  const all = registerUses(list);
  for (const reg of REGS) {
    const e = expected.get(reg)!;
    assert.deepEqual({ ...many.get(reg)! }, e, `${label}: identUsesMany(${reg})`);
    assert.deepEqual({ ...identUses(list, reg) }, e, `${label}: identUses(${reg})`);
    const whole = all.get(reg) ?? { reads: 0, writes: 0, nested: 0 };
    assert.deepEqual({ ...whole }, e, `${label}: registerUses(${reg})`);
  }
  // A cold fold over a fresh list identity must reproduce the memoised (or
  // splice-derived) map key for key - `noteRegisterUsesSplice`'s "a cold
  // walk never yields an all-zero entry either" note. Key *order* is only
  // guaranteed for a map that was itself built cold: a derived map keeps its
  // base's order, re-inserting each name whose count changed (which is why
  // no caller may iterate one and expect source order - they look names up).
  const cold = registerUses([...list]);
  assert.deepEqual([...cold.keys()].sort(), [...all.keys()].sort(), `${label}: key set`);
  if (coldOrder) assert.deepEqual([...cold.keys()], [...all.keys()], `${label}: key order`);
  for (const [name, u] of cold) assert.deepEqual({ ...all.get(name)! }, { ...u }, `${label}: cold vs memoised ${name}`);
}

test("register counts equal the walk they replaced, on fresh lists", () => {
  for (const len of [1, 5, 40, 130, 400]) {
    const r = rng(0x7e5 + len);
    agrees(randomList(r, len), `fresh list of ${len}`);
  }
});

test("one statement's counts are the same object across every list it is a member of", () => {
  const r = rng(0xc0ffee);
  const list = randomList(r, 30);
  const s = list[7]!;
  const first = stmtRegisterUses(s);
  assert.equal(stmtRegisterUses(s), first, "memoised on the statement's identity");
  // The whole-list counts of a one-statement list are exactly that
  // statement's own counts.
  const single = registerUses([s]);
  for (const reg of REGS) assert.deepEqual({ ...(single.get(reg) ?? { reads: 0, writes: 0, nested: 0 }) }, { ...(first.get(reg) ?? { reads: 0, writes: 0, nested: 0 }) }, `single-statement list, ${reg}`);
});

/**
 * The generation chain: `expr-rebuild`'s three rewrite shapes, applied one
 * after another, with `check.ts`'s `noteRegisterUsesSplice` carrying the
 * counts forward each time (the counts under test are precisely the ones a
 * *derived* map holds). Errors compound - step `n + 1` derives from step
 * `n`'s map - so a single wrong delta anywhere in the chain is caught.
 */
test("register counts survive a chain of splices with the same answers as a fresh walk", () => {
  for (const len of [40, 130, 400]) {
    const r = rng(0xba5e + len);
    let cur: readonly Stmt[] = randomList(r, len);
    agrees(cur, `chain start, len ${len}`);
    for (let step = 0; step < 60 && cur.length > 8; step++) {
      const shape = Math.floor(r() * 3);
      const at = Math.floor(r() * (cur.length - 4));
      let next: readonly Stmt[];
      let hiBefore: number;
      let hiAfter: number;
      if (shape === 0) {
        next = [...cur.slice(0, at), ...cur.slice(at + 1)];
        hiBefore = at + 1;
        hiAfter = at;
      } else if (shape === 1) {
        next = [...cur.slice(0, at), randomStmt(r, step), ...cur.slice(at + 1)];
        hiBefore = at + 1;
        hiAfter = at + 1;
      } else {
        const j = Math.min(at + 1 + Math.floor(r() * 4), cur.length - 1);
        const folded = [...cur.slice(at + 1, j), randomStmt(r, step)];
        next = [...cur.slice(0, at), ...folded, ...cur.slice(j + 1)];
        hiBefore = j + 1;
        hiAfter = j;
      }
      // Exactly `check.ts`'s call: the two windows' own counts, then the
      // derivation onto the new list identity.
      noteRegisterUsesSplice(cur, next, registerUses(cur.slice(at, hiBefore)), registerUses(next.slice(at, hiAfter)));
      cur = next;
      agrees(cur, `len ${len}, step ${step}, shape ${shape}`, false);
    }
  }
});
