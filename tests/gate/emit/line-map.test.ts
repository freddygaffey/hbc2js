// docs/specs/05-emitter.md §16 — the source<->disasm line map.
//
// Three properties, in order of importance:
//   1. NEVER WRONG. Every row points at an instruction that really exists in
//      the function at exactly that byte range, and the shape of the mapped
//      line agrees with the opcode behind it (`return` <- a return opcode, a
//      loop/`if` header <- a conditional jump).
//   2. NEVER OBSERVABLE. The printed text is byte-identical with and without
//      the `onStmtLine` hook — the map is pure observation, so no golden and
//      no equivalence verdict can move because it exists.
//   3. HONEST-PARTIAL, and getting no worse. A coverage ratchet, floors set at
//      what was measured when the feature landed. Raise them, never lower.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries, parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { rawFrames } from "../../../src/name-overlay/frames.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { lineMapCollector, type LineMapEntry } from "../../../src/emit/origin.ts";
import { isConditionalJump } from "../../../src/emit/conds.ts";
import type { Instruction } from "../../../src/disasm/decode.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";

interface Rendered {
  readonly fn: number;
  readonly code: string;
  readonly plain: string;
  readonly rows: readonly LineMapEntry[];
}

function renderAll(path: string, limit = Infinity): { readonly analysis: ModuleAnalysis; readonly rendered: Rendered[] } {
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  const analysis = analyseModule(module, { strictEnv: true });
  const rendered: Rendered[] = [];
  for (const [fn, frame] of rawFrames(analysis)) {
    if (rendered.length >= limit) break;
    const c = lineMapCollector();
    const code = printProgram([frame.node], { indent: "  ", onStmtLine: c.onStmtLine });
    rendered.push({ fn, code, plain: printProgram([frame.node], { indent: "  " }), rows: c.rows() });
  }
  return { analysis, rendered };
}

/** Every instruction of every function of the module, keyed `fn:offset` — a
 *  row may name a NESTED function, whose body `emitModule` prints inside its
 *  parent's (docs/specs/05-emitter.md §16). */
function instructionsOf(analysis: ModuleAnalysis): { get(key: string): Instruction | undefined } {
  const perFn = new Map<number, Map<number, Instruction>>();
  return {
    get(key) {
      const [f, off] = key.split(":").map(Number) as [number, number];
      let m = perFn.get(f);
      if (m === undefined) {
        m = new Map();
        for (const i of analysis.decoded(f).instructions) m.set(i.offset, i);
        perFn.set(f, m);
      }
      return m.get(off);
    },
  };
}

function construct(name: string, version = 96): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
}

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

/** The gate only ever ratchets this many functions of the big bundle — enough
 *  to be a real population, cheap enough to stay in a 2-minute gate. */
const RN_SAMPLE = 600;

const V96 = m4Binaries([""]).filter((b) => b.version === 96);

// ---------------------------------------------------------------------------
// 2. The hook changes nothing about the text.
// ---------------------------------------------------------------------------

test("§16: printing is byte-identical with and without the line-map hook", () => {
  assert.ok(V96.length > 20, `expected the v96 construct corpus, got ${V96.length}`);
  const differing: string[] = [];
  for (const b of V96) {
    for (const r of renderAll(b.path).rendered) if (r.code !== r.plain) differing.push(`${b.fixture} fn ${r.fn}`);
  }
  assert.deepEqual(differing, []);
});

// ---------------------------------------------------------------------------
// 1. Never wrong.
// ---------------------------------------------------------------------------

test("§16: every mapped row names a real instruction at exactly that byte range", () => {
  const bad: string[] = [];
  for (const b of V96) {
    const { analysis, rendered } = renderAll(b.path);
    const insns = instructionsOf(analysis);
    for (const r of rendered) {
      const lines = r.code.split("\n");
      for (const [line, fn, start, end] of r.rows) {
        const insn = insns.get(`${fn}:${start}`);
        if (insn === undefined) bad.push(`${b.fixture} fn ${r.fn}: line ${line} -> no instruction at ${fn}@${start}`);
        else if (insn.offset + insn.length !== end) bad.push(`${b.fixture} fn ${r.fn}: line ${line} -> ${fn}@${start} is ${insn.length} bytes, row says ${end - start}`);
        if (line < 1 || line > lines.length) bad.push(`${b.fixture} fn ${r.fn}: line ${line} is outside the ${lines.length}-line text`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
});

test("§16: rows are unique per line and sorted", () => {
  for (const b of V96) {
    for (const r of renderAll(b.path).rendered) {
      const seen = new Set<number>();
      let prev = 0;
      for (const [line] of r.rows) {
        assert.ok(!seen.has(line), `${b.fixture} fn ${r.fn}: line ${line} mapped twice`);
        assert.ok(line > prev, `${b.fixture} fn ${r.fn}: rows out of order at line ${line}`);
        seen.add(line);
        prev = line;
      }
    }
  }
});

test("§16: a `return` line maps to a return opcode; a loop header maps to a conditional jump", () => {
  // Every function of the whole v96 corpus, not a hand-picked one: the claim is
  // about the mapping rule, so a counter-example anywhere is a bug.
  //
  // `if (` is deliberately NOT in the loop-header class: besides the structurer's
  // own conditionals, `src/emit/lower.ts` synthesises guard `if`s straight from a
  // single instruction (`DeclareGlobalVar`'s hasOwnProperty guard,
  // `TryGetById`'s `"x" in globalThis` guard), and those rows are correct — the
  // instruction really did produce that line.
  const bad: string[] = [];
  let returns = 0;
  let headers = 0;
  for (const b of V96) {
    const { analysis, rendered } = renderAll(b.path);
    const insns = instructionsOf(analysis);
    for (const r of rendered) {
      const lines = r.code.split("\n");
      for (const [line, fn, start] of r.rows) {
        const text = lines[line - 1]!.trim();
        const name = insns.get(`${fn}:${start}`)?.name ?? "";
        if (text.startsWith("return")) {
          returns++;
          if (!name.startsWith("Ret")) bad.push(`${b.fixture} fn ${r.fn} line ${line}: \`${text}\` <- ${name}`);
        } else if (/^(?:\w+: )?(?:while|for) \(/.test(text) || /^(?:\w+: )?do \{$/.test(text)) {
          headers++;
          if (!isConditionalJump(name)) bad.push(`${b.fixture} fn ${r.fn} line ${line}: \`${text}\` <- ${name || `${fn}@${start} (no such instruction)`}`);
        }
      }
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
  assert.ok(returns > 50, `expected many mapped returns, got ${returns}`);
  assert.ok(headers > 20, `expected many mapped headers, got ${headers}`);
});

test("§16: a hand-checked statement — the while-loop fixture's `return` is the function's Ret", () => {
  const { analysis, rendered } = renderAll(construct("02-while-loop"));
  const top = rendered[0];
  assert.ok(top !== undefined);
  const lines = top.code.split("\n");
  const insns = instructionsOf(analysis);
  const returnRows = top.rows.filter(([line]) => lines[line - 1]!.trim().startsWith("return"));
  assert.ok(returnRows.length >= 1, "02-while-loop's first frame should map at least one return");
  for (const [, fn, start, end] of returnRows) {
    const insn = insns.get(`${fn}:${start}`)!;
    assert.match(insn.name, /^Ret/);
    assert.equal(end - start, insn.length);
  }
});

// ---------------------------------------------------------------------------
// 3. The coverage ratchet.
// ---------------------------------------------------------------------------

function coverage(rendered: readonly Rendered[]): number {
  let nonBlank = 0;
  let mapped = 0;
  for (const r of rendered) {
    nonBlank += r.code.split("\n").filter((l) => l.trim().length > 0).length;
    mapped += r.rows.length;
  }
  return mapped / nonBlank;
}

// Measured when §16 landed (2026-09-04): 0.6408 over the whole rn-template
// bundle, 0.6286 over the first 600 functions, 0.6761 over 02-while-loop. Floors are deliberately a little below the
// measurement so an unrelated readability pass that adds a line or two does not
// fail the gate; they are RAISED as coverage improves and NEVER lowered
// (docs/specs/05-emitter.md §16).
const RN_FLOOR = 0.6;
const WHILE_FLOOR = 0.65;

test("§16: coverage ratchet — rn-template", () => {
  const c = coverage(renderAll(RN_TEMPLATE, RN_SAMPLE).rendered);
  assert.ok(c >= RN_FLOOR, `line-map coverage on rn-template fell to ${c.toFixed(4)} (floor ${RN_FLOOR})`);
});

test("§16: coverage ratchet — 02-while-loop", () => {
  const c = coverage(renderAll(construct("02-while-loop")).rendered);
  assert.ok(c >= WHILE_FLOOR, `line-map coverage on 02-while-loop fell to ${c.toFixed(4)} (floor ${WHILE_FLOOR})`);
});
