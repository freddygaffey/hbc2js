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
import { call, id } from "../../../src/emit/ast.ts";
import type { Expr, Origin, Stmt } from "../../../src/emit/ast.ts";
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
const RN_FLOOR = 0.61;
const WHILE_FLOOR = 0.66;
// §16.2 landed inline-function-expression mapping (2026-09-04). Re-measured
// then: 0.5481 over the whole v96 construct corpus (0.3832 before) and 0.4650
// over `23-generator-basic` alone (0.1306 before — a generator's whole state
// machine prints inside the resume-dispatcher closure, an inline function
// expression, so almost nothing in it used to be mappable). Same margin rule.
const CORPUS_FLOOR = 0.53;
const GENERATOR_FLOOR = 0.44;

test("§16: coverage ratchet — rn-template", () => {
  const c = coverage(renderAll(RN_TEMPLATE, RN_SAMPLE).rendered);
  assert.ok(c >= RN_FLOOR, `line-map coverage on rn-template fell to ${c.toFixed(4)} (floor ${RN_FLOOR})`);
});

test("§16: coverage ratchet — 02-while-loop", () => {
  const c = coverage(renderAll(construct("02-while-loop")).rendered);
  assert.ok(c >= WHILE_FLOOR, `line-map coverage on 02-while-loop fell to ${c.toFixed(4)} (floor ${WHILE_FLOOR})`);
});

// ---------------------------------------------------------------------------
// §16.2: inline function expressions.
//
// The first four tests above already hold these rows to the same standard as
// every other row (real instruction, exact byte range, one per line, text
// unchanged). What is specific to the inline form is the *arithmetic*: the
// body prints into its own buffer and is spliced into the middle of an
// enclosing line, so its rows are rebased onto wherever that splice landed.
// These are rung-private, hand-built ASTs — the line numbers are the claim, so
// they are asserted exactly, and no shared fixture's output is involved.
// ---------------------------------------------------------------------------

function origin(fn: number, start: number): Origin {
  return { fn, start, end: start + 2 };
}

/** `mark(fn, start)` — a statement that prints as `marker<fn>_<start>();` and
 *  carries the origin the test then looks for. */
function mark(fn: number, start: number): Stmt {
  return { k: "expr", expr: call(id(`marker${fn}_${start}`), []), origin: origin(fn, start) };
}

function inlineFunc(name: string | null, body: readonly Stmt[]): Expr {
  return { k: "func", name, params: [], body };
}

function printWithRows(body: readonly Stmt[]): { readonly code: string; readonly rows: readonly LineMapEntry[] } {
  const c = lineMapCollector();
  const code = printProgram(body, { indent: "  ", onStmtLine: c.onStmtLine });
  assert.equal(code, printProgram(body, { indent: "  " }), "the hook changed the text");
  return { code, rows: c.rows() };
}

/** The 1-based line of the (unique) line whose trimmed text is `text`. */
function lineOf(code: string, text: string): number {
  const lines = code.split("\n");
  const hits = lines.map((l, i) => [l.trim(), i + 1] as const).filter(([t]) => t === text);
  assert.equal(hits.length, 1, `expected exactly one \`${text}\` line in\n${code}`);
  return hits[0]![1];
}

test("§16.2: a statement inside an inline function expression is mapped, with the inner function's own fn", () => {
  const { code, rows } = printWithRows([
    { k: "expr", expr: call(id("outer"), []), origin: origin(1, 0) },
    { k: "expr", expr: call(id("useEffect"), [inlineFunc(null, [mark(7, 10)])]), origin: origin(1, 4) },
  ]);
  const inner = rows.find((r) => r[1] === 7);
  assert.ok(inner !== undefined, `no row for the inner function in\n${code}`);
  assert.deepEqual([...inner], [lineOf(code, "marker7_10();"), 7, 10, 12]);
  // …and the enclosing statement still maps to its own instruction, on the
  // line the inline function's `{` shares with it.
  assert.deepEqual(
    rows.filter((r) => r[1] === 1).map((r) => r[0]),
    [1, 2],
  );
});

test("§16.2: nested inline function expressions compose — the innermost statement maps to the innermost fn", () => {
  const innermost = inlineFunc(null, [mark(9, 20)]);
  const { code, rows } = printWithRows([
    { k: "expr", expr: call(id("boot"), []), origin: origin(1, 0) },
    {
      k: "expr",
      expr: call(id("outer"), [inlineFunc(null, [mark(7, 10), { k: "expr", expr: call(id("inner"), [innermost]), origin: origin(7, 14) }])]),
      origin: origin(1, 4),
    },
  ]);
  const first = (fn: number): LineMapEntry => {
    const r = rows.find((x) => x[1] === fn);
    assert.ok(r !== undefined, `no row for fn ${fn} in\n${code}`);
    return r;
  };
  assert.deepEqual([...new Set(rows.map((r) => r[1]))].sort((a, b) => a - b), [1, 7, 9]);
  assert.deepEqual([...first(9)], [lineOf(code, "marker9_20();"), 9, 20, 22]);
  assert.deepEqual([...first(7)], [lineOf(code, "marker7_10();"), 7, 10, 12]);
  // Every marker row's line really is the line that marker printed on — the
  // whole point of the rebase. (The one non-marker row here is the statement
  // that *contains* the innermost function, `inner(function () {`.)
  const lines = code.split("\n");
  let markers = 0;
  for (const [line, fn, start] of rows) {
    const text = lines[line - 1]!.trim();
    if (!text.startsWith("marker")) continue;
    markers++;
    assert.equal(text, `marker${fn}_${start}();`);
  }
  assert.equal(markers, 2);
});

test("§16.2: onFunctionRange covers an inline function expression and the declarations inside it", () => {
  const ranges: Array<[string, number, number]> = [];
  const body: readonly Stmt[] = [
    { k: "expr", expr: call(id("boot"), []) },
    { k: "expr", expr: call(id("register"), [inlineFunc("_fn7", [{ k: "func", name: "_fn9", params: [], body: [{ k: "expr", expr: call(id("deep"), []) }] }])]) },
  ];
  const code = printProgram(body, { indent: "  ", onFunctionRange: (name, startLine, endLine) => ranges.push([name, startLine, endLine]) });
  assert.equal(code, printProgram(body, { indent: "  " }), "the hook changed the text");
  const lines = code.split("\n");
  for (const [name, startLine, endLine] of ranges) {
    assert.match(lines[startLine - 1]!, new RegExp(`function ${name}\\(`), `${name} start line`);
    // An inline function's `}` shares its line with the rest of the enclosing
    // statement (`});`), so the claim is "the line the closing brace is on".
    assert.match(lines[endLine - 1]!.trim(), /^\}/, `${name} end line`);
  }
  assert.deepEqual(
    ranges.map(([name]) => name).sort(),
    ["_fn7", "_fn9"],
  );
});

test("§16: coverage ratchet — the whole v96 construct corpus", () => {
  const all: Rendered[] = [];
  for (const b of V96) all.push(...renderAll(b.path).rendered);
  const c = coverage(all);
  assert.ok(c >= CORPUS_FLOOR, `line-map coverage on the v96 corpus fell to ${c.toFixed(4)} (floor ${CORPUS_FLOOR})`);
});

test("§16.2: coverage ratchet — 23-generator-basic, whose body is one big inline function expression", () => {
  const c = coverage(renderAll(construct("23-generator-basic")).rendered);
  assert.ok(c >= GENERATOR_FLOOR, `line-map coverage on 23-generator-basic fell to ${c.toFixed(4)} (floor ${GENERATOR_FLOOR})`);
});
