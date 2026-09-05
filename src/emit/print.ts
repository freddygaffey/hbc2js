// docs/specs/05-emitter.md §2 — the in-house printer. Byte-stable output, no
// dependency, explicit precedence so parentheses are added exactly where needed.
import type { ClassMember, Expr, Origin, Param, Pattern, PatternElement, Stmt } from "./ast.ts";
import { originOf } from "./origin.ts";
import { jsxToCall } from "./ast.ts";

/** F16 §3: render a pattern. `hole` prints as an empty slot (a run of them
 *  is what gives `[a, , b]` its double comma — handled by the caller joining
 *  on `", "` around an empty string, same as `array`'s own elision story). */
function renderPattern(p: Pattern): string {
  switch (p.k) {
    case "pid":
      return p.name;
    case "parr":
      return `[${p.elements.map(renderPatternElement).join(", ")}]`;
    case "pobj":
      return `{${p.props.map((prop) => renderProp(prop.key, prop.value)).join(", ")}}`;
  }
}

function renderPatternElement(el: PatternElement): string {
  switch (el.k) {
    case "hole":
      return "";
    case "prest":
      return `...${renderPattern(el.target)}`;
    case "pel":
      return renderPattern(el.target) + (el.init !== undefined ? ` = ${expr(el.init, ASSIGNMENT)}` : "");
  }
}

function renderProp(key: string, value: PatternElement): string {
  if (value.k === "prest") return renderPatternElement(value);
  // Shorthand (`{ a }` / `{ a = 1 }`) exactly when the value is a bare `pid`
  // with the same name as the key — the common case (a plain or defaulted
  // property, un-renamed).
  if (value.k === "pel" && value.target.k === "pid" && value.target.name === key) {
    return value.init !== undefined ? `${key} = ${expr(value.init, ASSIGNMENT)}` : key;
  }
  return `${key}: ${renderPatternElement(value)}`;
}

/** F15: `(a, b = 1, ...rest)` — a defaulted parameter's `init` is printed at
 *  assignment precedence, so a `k:"seq"` default parenthesises itself
 *  (`(a = (f(), 1))`) exactly as an assignment's RHS does. */
function paramList(params: readonly Param[]): string {
  return params.map((x) => (x.rest === true ? "..." : "") + x.name + (x.init !== undefined ? ` = ${expr(x.init, ASSIGNMENT)}` : "")).join(", ");
}

// Higher binds tighter. Matches the ECMAScript grammar's operator table.
const PRIMARY = 21;
const MEMBER = 20;
const UNARY = 16;
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "**": 15,
  "*": 14,
  "/": 14,
  "%": 14,
  "+": 13,
  "-": 13,
  "<<": 12,
  ">>": 12,
  ">>>": 12,
  "<": 11,
  ">": 11,
  "<=": 11,
  ">=": 11,
  instanceof: 11,
  in: 11,
  "==": 10,
  "!=": 10,
  "===": 10,
  "!==": 10,
  "&": 9,
  "^": 8,
  "|": 7,
  "&&": 6,
  "||": 5,
  "??": 5,
};
const CONDITIONAL = 4;
const ASSIGNMENT = 3;
const SEQUENCE = 2;

function precedence(e: Expr): number {
  switch (e.k) {
    case "ident":
    case "lit":
    case "this":
    case "argumentsObject":
    case "array":
    case "object":
    case "func":
    case "class": // F24-1: a class expression is a primary expression
    case "spread": // F17: never wrapped in parens by `expr()`; ASSIGNMENT is a safe lower bound
    case "template": // F14: a template literal is a primary expression
    case "jsx": // D20: a JSX element is a primary expression (and so is the call it lowers to, at MEMBER — PRIMARY is the safe lower bound for both renderings)
    case "regex": // F23-3: `/x/g.test(s)` never parenthesises the literal as a member base
      return PRIMARY;
    case "member":
    case "optmember": // F18: same precedence as `member` — a chain never parenthesises an inner link
    case "call":
    case "optcall": // F18: same precedence as `call`
    case "new":
    case "tagged": // F14: member/call level, so `(a + b)`x`` parenthesises its tag
      return MEMBER;
    case "unary":
      return UNARY;
    case "bin":
    case "logical":
      return BINARY_PRECEDENCE[e.op] ?? 1;
    case "cond":
      return CONDITIONAL;
    case "assign":
    case "destructure": // F16: printed at assignment precedence, like `assign`
    case "yield": // F25-1: `yield` binds looser than every operator; assignment level
      return ASSIGNMENT;
    case "await": // F25-1: a unary operator
      return UNARY;
    case "seq":
      return SEQUENCE;
  }
}

export interface PrintOptions {
  readonly indent: string;
  /** D20 (`--jsx`): render a `jsx` node as JSX. Default `false`: lower it
   *  back to its element-creation call (`jsxToCall`) — runnable JS. */
  readonly jsx?: boolean;
  /**
   * P2.1 §2.7 range-recording hook: called once per statement-level
   * `k:"func"` node actually printed (module factories + hoisted `_fnN`
   * children, at any nesting depth — the vast majority of closures,
   * `src/split/index.ts`'s own "hoisted siblings" form), with the 1-based
   * start/end line *within this `printProgram` call's own returned text*
   * (the caller adds whatever header lines it prepends before the text it
   * writes to disk, e.g. `src/split/index.ts`'s module-comment line).
   * Since §16.2's sentinel landed it is ALSO invoked for the inline
   * function-*expression* form (loop-local closures, `src/emit/index.ts`'s
   * `inlineFunctions` — printed via `render()`'s own `"func"` case, a
   * separate text build spliced into the middle of an enclosing line), whose
   * start line is recovered honestly from where that splice actually landed;
   * its end line is the line its closing brace is on, shared with the rest of
   * the enclosing statement (`});`). An ANONYMOUS inline function still gets
   * no row: `ranges.jsonl` keys on the `_fnN` name, and a range naming nothing
   * is not a fact a caller can use. `ranges.jsonl` only ever states what was
   * actually observed (docs/specs/10-artifact-format.md §0's truth rule).
   */
  readonly onFunctionRange?: (name: string, startLine: number, endLine: number) => void;
  /**
   * §16 source<->disasm alignment: called once per printed statement that
   * carries a bytecode origin (`src/emit/origin.ts`), with the 1-based line —
   * within this `printProgram` call's own returned text — on which that
   * statement's first character sits. Statements without an origin are simply
   * not reported; the map is honest-partial by design, never inferred.
   * Purely observational: the returned text is byte-identical with and
   * without this hook (asserted in `tests/gate/emit/line-map.test.ts`).
   */
  readonly onStmtLine?: (line: number, origin: Origin) => void;
}

/** `PrintOptions.jsx` for the `printProgram` call in flight — expressions
 *  render through module-level `expr`/`render`, which take no options. */
let jsxOutput = false;

/** Statement-level `k:"func"` marks collected for the `printProgram` call in
 *  flight, as `[startIdx, endIdxExclusive)` into that call's own `out` array
 *  (see `printProgram`'s post-pass, which converts these to physical line
 *  numbers in one linear scan once the array is complete — avoids an O(n^2)
 *  rescan per function in bundles with thousands of them, e.g. rn-template). */
let funcMarks: Array<{ readonly name: string; readonly startIdx: number; readonly endIdxExclusive: number }> | undefined;

/** §16 statement-origin marks for the `printProgram` call in flight, as an
 *  index into that call's own `out` array (converted to a physical line by the
 *  same prefix-sum post-pass `funcMarks` uses). */
let originMarks: Array<{ readonly idx: number; readonly origin: Origin }> | undefined;

/** §16.2 — the inline-function-expression sentinel. An expression-level
 *  `k:"func"` prints its body into its OWN array and is then spliced into the
 *  middle of an enclosing `out` entry, so at collection time it cannot know
 *  which physical line its `{` will land on. It therefore records its inner
 *  marks as lines *relative to its own text* and prefixes that text with
 *  `\uE000<id base-36>\uE001` — a private-use marker containing no newline, so
 *  it perturbs no line count. `printProgram`'s post-pass finds each sentinel,
 *  reads off the absolute line it sits on, rebases that record's marks onto it,
 *  and STRIPS the sentinels before the text is returned. Nested inline
 *  functions compose for free: a child's sentinel travels up inside its
 *  parent's text and is resolved by the same single top-level scan. Inserted
 *  only while a hook is live (`inlineRecords !== undefined`), so a hookless
 *  print pays nothing and returns byte-identical text. */
const SENTINEL_OPEN = "\uE000";
const SENTINEL_CLOSE = "\uE001";

interface InlineRecord {
  readonly marks: ReadonlyArray<{ readonly relLine: number; readonly origin: Origin }>;
  readonly ranges: ReadonlyArray<{ readonly name: string; readonly relStart: number; readonly relEnd: number }>;
}

/** Inline-function records for the `printProgram` call in flight, indexed by
 *  the id written into the sentinel. `undefined` when no hook is set. */
let inlineRecords: InlineRecord[] | undefined;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function printProgram(body: readonly Stmt[], opts: PrintOptions = { indent: "  " }): string {
  const out: string[] = [];
  const savedJsx = jsxOutput;
  const savedMarks = funcMarks;
  const savedOrigins = originMarks;
  const savedInline = inlineRecords;
  const collecting = opts.onFunctionRange !== undefined || opts.onStmtLine !== undefined;
  jsxOutput = opts.jsx === true;
  funcMarks = opts.onFunctionRange !== undefined ? [] : undefined;
  originMarks = opts.onStmtLine !== undefined ? [] : undefined;
  inlineRecords = collecting ? [] : undefined;
  try {
    for (const s of body) printStmt(s, 0, out, opts);
    if (collecting) {
      // Prefix sum: `lineStart[i]` = 1-based physical line of `out[i]`'s
      // first character (§2.7's line-tracking hook, see `PrintOptions` doc).
      // The same single scan resolves — and removes — every inline-function
      // sentinel (§16.2), so the returned text is unchanged by the hook.
      const records = inlineRecords!;
      const sentinelLine: number[] = new Array(records.length).fill(0);
      const lineStart: number[] = new Array(out.length + 1);
      lineStart[0] = 1;
      for (let i = 0; i < out.length; i++) {
        const s = out[i]!;
        let newlines: number;
        if (records.length > 0 && s.indexOf(SENTINEL_OPEN) >= 0) {
          const parts: string[] = [];
          let pos = 0;
          newlines = 0;
          for (;;) {
            const at = s.indexOf(SENTINEL_OPEN, pos);
            if (at < 0) break;
            const close = s.indexOf(SENTINEL_CLOSE, at + 1);
            if (close < 0) break; // cannot happen: the pair is written together
            const head = s.slice(pos, at);
            parts.push(head);
            newlines += countNewlines(head);
            const id = Number.parseInt(s.slice(at + 1, close), 36);
            // A record whose text was printed twice (or not at all) cannot be
            // tied to one line: `-1` drops it rather than guess (truth rule).
            sentinelLine[id] = sentinelLine[id] === 0 ? lineStart[i]! + newlines : -1;
            pos = close + 1;
          }
          const tail = s.slice(pos);
          parts.push(tail);
          newlines += countNewlines(tail);
          out[i] = parts.join("");
        } else {
          newlines = countNewlines(s);
        }
        lineStart[i + 1] = lineStart[i]! + 1 + newlines;
      }
      if (funcMarks !== undefined && opts.onFunctionRange !== undefined) for (const m of funcMarks) opts.onFunctionRange(m.name, lineStart[m.startIdx]!, lineStart[m.endIdxExclusive - 1]!);
      if (originMarks !== undefined && opts.onStmtLine !== undefined) for (const m of originMarks) if (m.idx < out.length) opts.onStmtLine(lineStart[m.idx]!, m.origin);
      // Inline-function rows last: a record's own lines are relative to its
      // text, whose first line is the line its sentinel was found on.
      for (let id = 0; id < records.length; id++) {
        const base = sentinelLine[id]!;
        if (base <= 0) continue;
        const r = records[id]!;
        if (opts.onStmtLine !== undefined) for (const m of r.marks) opts.onStmtLine(base + m.relLine - 1, m.origin);
        if (opts.onFunctionRange !== undefined) for (const g of r.ranges) opts.onFunctionRange(g.name, base + g.relStart - 1, base + g.relEnd - 1);
      }
    }
  } finally {
    jsxOutput = savedJsx;
    funcMarks = savedMarks;
    originMarks = savedOrigins;
    inlineRecords = savedInline;
  }
  return out.join("\n") + "\n";
}

/** JSX text/attribute-string safety: printed bare, the text must read back
 *  as exactly the literal — no braces/angles (children), no quote/entity
 *  (`&` starts one), no newline (JSX trims lines), no edge whitespace. */
function jsxSafeText(lit: Expr, where: "child" | "attr"): string | null {
  if (lit.k !== "lit" || !lit.text.startsWith('"')) return null;
  let value: unknown;
  try {
    value = JSON.parse(lit.text);
  } catch {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  if (/[\n\r\t"&\\]|[^\x20-\x7e]/.test(value)) return null;
  if (where === "child" && (/[{}<>]/.test(value) || value !== value.trim())) return null;
  return value;
}

function renderJsx(e: Extract<Expr, { k: "jsx" }>): string {
  const shown = e.tagDisplay ?? e.tag;
  const tag = shown.k === "lit" ? (jsxSafeText(shown, "attr") ?? shown.text) : expr(shown, MEMBER);
  const attr = (name: string, value: Expr | null): string => {
    if (value === null) return ` ${name}`;
    const text = jsxSafeText(value, "attr");
    return text !== null ? ` ${name}="${text}"` : ` ${name}={${expr(value, 0)}}`;
  };
  // The automatic runtime's key is the call's 3rd argument, shown first.
  const key = e.factory.runtime === "automatic" && e.factory.key !== null ? [attr("key", e.factory.key)] : [];
  const attrs = [...key, ...e.attrs.map((a) => ("spread" in a ? ` {...${expr(a.spread, 0)}}` : attr(a.name, a.value)))];
  if (e.selfClosing && e.children.length === 0) return `<${tag}${attrs.join("")} />`;
  const children = e.children.map((c) => {
    if (c.k === "text") {
      const text = jsxSafeText(c.lit, "child");
      if (text !== null) return text;
      return `{${expr(c.lit, 0)}}`;
    }
    return c.expr.k === "jsx" ? renderJsx(c.expr) : `{${expr(c.expr, 0)}}`;
  });
  return `<${tag}${attrs.join("")}>${children.join("")}</${tag}>`;
}

function pad(depth: number, opts: PrintOptions): string {
  return opts.indent.repeat(depth);
}

function printBody(body: readonly Stmt[], depth: number, out: string[], opts: PrintOptions): void {
  for (const s of body) printStmt(s, depth, out, opts);
}

function printStmt(s: Stmt, depth: number, out: string[], opts: PrintOptions): void {
  const p = pad(depth, opts);
  if (originMarks !== undefined) {
    // `out.length` is the index of the entry this statement is about to push
    // first, i.e. the entry its first character lands in.
    const o = originOf(s);
    if (o !== undefined) originMarks.push({ idx: out.length, origin: o });
  }
  switch (s.k) {
    case "expr":
      // F16: an object-pattern destructuring assignment in statement
      // position must be parenthesised — a bare leading `{` parses as a
      // block statement, not an object pattern.
      if (s.expr.k === "destructure" && s.expr.pattern.k === "pobj") {
        out.push(`${p}(${expr(s.expr, 0)});`);
        return;
      }
      // F24-1: a bare `class` expression in statement position would parse as
      // a class *declaration* (and a nameless one is a syntax error), so it is
      // parenthesised exactly as the object-pattern case above is.
      if (s.expr.k === "class") {
        out.push(`${p}(${render(s.expr)});`);
        return;
      }
      out.push(`${p}${expr(s.expr, 0)};`);
      return;
    case "decl":
      if (s.names.length === 0) return;
      out.push(`${p}${s.kind} ${s.names.join(", ")};`);
      return;
    case "init":
      out.push(`${p}${s.kind} ${s.name} = ${expr(s.value, ASSIGNMENT)};`);
      return;
    case "if": {
      out.push(`${p}if (${expr(s.test, 0)}) {`);
      printBody(s.then, depth + 1, out, opts);
      // spec 09 F11 (src/passes/if-chain C3): `elseIf` marks an `else` arm
      // that was a chain link. Print `} else if (…) {` only when that arm is
      // exactly one `if` (stage B folded the condition block away); anything
      // else falls back to `} else {`, exactly as LoopForm.init/.step fall
      // back to `while`.
      let cur: Stmt & { k: "if" } = s;
      for (;;) {
        const link: Stmt | undefined = cur.elseIf === true && cur.else.length === 1 ? cur.else[0] : undefined;
        if (link === undefined || link.k !== "if") break;
        out.push(`${p}} else if (${expr(link.test, 0)}) {`);
        printBody(link.then, depth + 1, out, opts);
        cur = link;
      }
      if (cur.else.length > 0) {
        out.push(`${p}} else {`);
        printBody(cur.else, depth + 1, out, opts);
      }
      out.push(`${p}}`);
      return;
    }
    case "while":
      out.push(`${p}${s.label === null ? "" : `${s.label}: `}while (${s.test === undefined ? "true" : expr(s.test, 0)}) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
    case "do-while":
      out.push(`${p}${s.label === null ? "" : `${s.label}: `}do {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}} while (${expr(s.test, 0)});`);
      return;
    case "for":
      out.push(`${p}${s.label === null ? "" : `${s.label}: `}for (${s.init === null ? "" : expr(s.init, 0)}; ${expr(s.test, 0)}; ${s.update === null ? "" : expr(s.update, 0)}) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
    case "for-in":
    case "for-of": {
      const decl = s.decl === null ? expr(s.left, 0) : `${s.decl} ${expr(s.left, 0)}`;
      out.push(`${p}${s.label === null ? "" : `${s.label}: `}for (${decl} ${s.k === "for-in" ? "in" : "of"} ${expr(s.right, 0)}) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
    }
    case "labeled":
      out.push(`${p}${s.label}: {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
    case "break":
      out.push(`${p}break${s.label === null ? "" : ` ${s.label}`};`);
      return;
    case "continue":
      out.push(`${p}continue${s.label === null ? "" : ` ${s.label}`};`);
      return;
    case "return":
      out.push(`${p}return${s.arg === null ? "" : ` ${expr(s.arg, 0)}`};`);
      return;
    case "throw":
      out.push(`${p}throw ${expr(s.arg, 0)};`);
      return;
    case "try":
      out.push(`${p}try {`);
      printBody(s.block, depth + 1, out, opts);
      out.push(s.param === null ? `${p}} catch {` : `${p}} catch (${s.param}) {`);
      printBody(s.handler, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
    case "switch":
      out.push(`${p}switch (${expr(s.disc, 0)}) {`);
      for (const c of s.cases) {
        out.push(`${p}${opts.indent}${c.test === null ? "default:" : `case ${expr(c.test, 0)}:`}`);
        printBody(c.body, depth + 2, out, opts);
      }
      out.push(`${p}}`);
      return;
    case "func": {
      const startIdx = out.length;
      out.push(`${p}${s.async === true ? "async " : ""}function${s.generator === true ? "*" : ""} ${s.name}(${paramList(s.params)}) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      if (funcMarks !== undefined) funcMarks.push({ name: s.name, startIdx, endIdxExclusive: out.length });
      return;
    }
    case "classdecl":
      // F24-1: declaration position -- no parentheses, no trailing semicolon.
      out.push(`${p}${s.value.k === "class" ? withMarksSuspended(() => renderClass({ ...s.value, k: "class", name: s.name } as Extract<Expr, { k: "class" }>)) : `class ${s.name} { }`}`);
      return;
    case "directive":
      out.push(`${p}"${s.text}";`);
      return;
    case "iife":
      out.push(`${p}(function () {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}})();`);
      return;
    case "comment":
      for (const line of s.text.split("\n")) out.push(`${p}// ${line}`);
      return;
    case "raw":
      for (const line of s.text.split("\n")) out.push(line.length === 0 ? "" : `${p}${line}`);
      return;
  }
}

/** Renders `e`, parenthesised when its precedence is below `min`. */
export function expr(e: Expr, min: number): string {
  const text = render(e);
  return precedence(e) < min ? `(${text})` : text;
}

/** F24-1: run `f` with the line-map/function-mark collectors switched off.
 *  See the `class` case of `render` for why. */
function withMarksSuspended<T>(f: () => T): T {
  const savedOrigins = originMarks;
  const savedFuncs = funcMarks;
  originMarks = undefined;
  funcMarks = undefined;
  try {
    return f();
  } finally {
    originMarks = savedOrigins;
    funcMarks = savedFuncs;
  }
}

/** F24-1: `class N extends S { ... }`, members in array order (which is the
 *  install order the `class-recover` rung captured). */
function renderClass(e: Extract<Expr, { k: "class" }>): string {
  const head = `class${e.name !== null ? ` ${e.name}` : ""}${e.superClass !== null ? ` extends ${expr(e.superClass, MEMBER)}` : ""} {`;
  const lines: string[] = [];
  for (const m of e.members) lines.push(...classMemberLines(m));
  return lines.length === 0 ? `${head}}` : `${head}\n${lines.join("\n")}\n}`;
}

function classMemberKey(m: ClassMember): string {
  if (m.computed) return `[${expr(m.key, ASSIGNMENT)}]`;
  if (m.key.k === "ident") return m.key.name;
  return render(m.key);
}

function classMemberLines(m: ClassMember): string[] {
  const key = `${m.static ? "static " : ""}${classMemberKey(m)}`;
  if (m.kind === "field") return [`  ${key}${m.value === null ? "" : ` = ${expr(m.value, ASSIGNMENT)}`};`];
  const fn = m.value;
  if (fn === null || fn.k !== "func") return [`  ${key} = ${fn === null ? "undefined" : expr(fn, ASSIGNMENT)};`];
  const prefix = `${fn.async === true ? "async " : ""}${m.kind === "get" ? "get " : m.kind === "set" ? "set " : ""}${fn.generator === true ? "*" : ""}`;
  const out: string[] = [`  ${prefix}${key}(${paramList(fn.params)}) {`];
  printBody(fn.body, 2, out, { indent: "  " });
  out.push("  }");
  return out;
}

function render(e: Expr): string {
  switch (e.k) {
    case "ident":
      return e.name;
    case "lit":
      return e.text;
    case "this":
      return "this";
    case "argumentsObject":
      return "arguments";
    case "regex":
      // F23-3/R-L5: an empty pattern is never printed as `//` (a comment
      // opener) — the writer computes `pattern` from `.source`, which is
      // `(?:)` for the empty case, so this can only fire on a malformed
      // hand-built node.
      if (e.pattern === "") throw new Error("regex literal: empty pattern would print as `//`");
      return `/${e.pattern}/${e.flags}`;
    case "member": {
      // A numeric-literal callee/object needs parentheses: `1 .x` is a syntax
      // trap, and `(1).x` is the standard workaround.
      const objText = expr(e.obj, MEMBER);
      const obj = e.obj.k === "lit" && /^-?\d/.test(e.obj.text) ? `(${e.obj.text})` : objText;
      return e.computed ? `${obj}[${expr(e.prop, 0)}]` : `${obj}.${(e.prop as { text: string }).text}`;
    }
    case "optmember": {
      // F18: same numeric-literal-object trap as `member`.
      const objText = expr(e.obj, MEMBER);
      const obj = e.obj.k === "lit" && /^-?\d/.test(e.obj.text) ? `(${e.obj.text})` : objText;
      return e.computed ? `${obj}?.[${expr(e.prop, 0)}]` : `${obj}?.${(e.prop as { text: string }).text}`;
    }
    case "call":
      return `${expr(e.callee, MEMBER)}(${e.args.map((a) => expr(a, ASSIGNMENT)).join(", ")})`;
    case "optcall": // F18
      return `${expr(e.callee, MEMBER)}?.(${e.args.map((a) => expr(a, ASSIGNMENT)).join(", ")})`;
    case "new":
      return `new ${expr(e.callee, MEMBER + 1)}(${e.args.map((a) => expr(a, ASSIGNMENT)).join(", ")})`;
    case "bin":
    case "logical": {
      const prec = BINARY_PRECEDENCE[e.op] ?? 1;
      const spaced = /^[a-z]/.test(e.op);
      const left = expr(e.left, prec);
      // Right operand needs prec+1 for left-associative operators.
      const right = expr(e.right, e.op === "**" ? prec : prec + 1);
      return spaced ? `${left} ${e.op} ${right}` : `${left} ${e.op} ${right}`;
    }
    case "unary": {
      const inner = expr(e.arg, UNARY);
      // `- -x` and `+ +x` must not run together into `--`/`++`.
      const sep = (e.op === "-" && inner.startsWith("-")) || (e.op === "+" && inner.startsWith("+")) ? " " : "";
      return `${e.op}${sep}${inner}`;
    }
    case "assign":
      return `${expr(e.target, MEMBER)} = ${expr(e.value, ASSIGNMENT)}`;
    case "yield": // F25-1
      return e.arg === null ? (e.delegate ? "yield*" : "yield") : `yield${e.delegate ? "*" : ""} ${expr(e.arg, ASSIGNMENT)}`;
    case "await": // F25-1
      return `await ${expr(e.arg, UNARY)}`;
    case "destructure": // F16
      return `${renderPattern(e.pattern)} = ${expr(e.source, ASSIGNMENT)}`;
    case "cond":
      return `${expr(e.test, CONDITIONAL + 1)} ? ${expr(e.then, ASSIGNMENT)} : ${expr(e.else, ASSIGNMENT)}`;
    case "array":
      return `[${e.elements.map((x) => expr(x, ASSIGNMENT)).join(", ")}]`;
    case "object":
      return `{${e.props.map((p) => ("k" in p ? `...${expr(p.arg, ASSIGNMENT)}` : `${p.computed ? `[${p.key}]` : p.key}: ${expr(p.value, ASSIGNMENT)}`)).join(", ")}}`;
    case "spread": // F17
      return `...${expr(e.arg, ASSIGNMENT)}`;
    case "seq":
      return e.exprs.map((x) => expr(x, ASSIGNMENT)).join(", ");
    case "template": {
      // F14: quasis are raw source text, printed verbatim — the node's
      // builder owns escaping (docs/specs/passes/14-template-literal.md §3).
      let out = "`";
      for (let i = 0; i < e.quasis.length; i++) {
        out += e.quasis[i];
        if (i < e.exprs.length) out += "${" + expr(e.exprs[i]!, 0) + "}";
      }
      return out + "`";
    }
    case "tagged":
      return `${expr(e.tag, MEMBER)}${render(e.quasi)}`;
    case "jsx":
      // D20: JSX only under `--jsx`; otherwise the exact call it stands for.
      return jsxOutput ? renderJsx(e) : render(jsxToCall(e));
    case "class":
      // F24-1. The body prints with the same convention the `func` expression
      // above uses: its own two-space indentation, spliced into whatever entry
      // the enclosing statement is building. The line-map marks are suspended
      // across it -- a member body is not a physical line of the enclosing
      // `out` array, so a mark taken inside it could not name one (spec 05
      // section 16's "partial by design").
      return withMarksSuspended(() => renderClass(e));
    case "func": {
      const out: string[] = [];
      const header = `${e.async === true ? "async " : ""}function${e.generator === true ? "*" : ""} ${e.name ?? ""}(${paramList(e.params)}) {`;
      // §16.2: this body prints into a SEPARATE array whose text is then
      // spliced into the middle of an enclosing `out` entry, so a mark taken
      // here cannot name a physical line. With no hook live there is nothing
      // to collect and nothing to insert — the hookless path below is exactly
      // the code that shipped before the sentinel existed.
      if (inlineRecords === undefined) {
        printBody(e.body, 1, out, { indent: "  " });
        return `${header}\n${out.join("\n")}\n}`;
      }
      // With a hook live: collect this body's marks against its OWN array,
      // convert them to lines relative to this function's own text (line 1 is
      // `header`, so `out[0]` starts on line 2) and hand them to
      // `printProgram`'s post-pass through a sentinel it can locate.
      const savedOrigins = originMarks;
      const savedFuncs = funcMarks;
      const mine: typeof originMarks = savedOrigins !== undefined ? [] : undefined;
      const mineFuncs: typeof funcMarks = savedFuncs !== undefined ? [] : undefined;
      originMarks = mine;
      funcMarks = mineFuncs;
      try {
        printBody(e.body, 1, out, { indent: "  " });
      } finally {
        originMarks = savedOrigins;
        funcMarks = savedFuncs;
      }
      const relStart: number[] = new Array(out.length + 1);
      relStart[0] = 2;
      for (let i = 0; i < out.length; i++) relStart[i + 1] = relStart[i]! + 1 + countNewlines(out[i]!);
      const marks = (mine ?? []).filter((m) => m.idx < out.length).map((m) => ({ relLine: relStart[m.idx]!, origin: m.origin }));
      const ranges = (mineFuncs ?? []).map((m) => ({ name: m.name, relStart: relStart[m.startIdx]!, relEnd: relStart[m.endIdxExclusive - 1]! }));
      // …and this function's own range, when `emitModule` gave it the `_fnN`
      // name `ranges.jsonl` keys on. An anonymous one gets no row: a range
      // that names nothing is not a fact anybody can use.
      if (typeof e.name === "string" && e.name.length > 0) ranges.push({ name: e.name, relStart: 1, relEnd: relStart[out.length]! });
      const id = inlineRecords.length;
      inlineRecords.push({ marks, ranges });
      return `${SENTINEL_OPEN}${id.toString(36)}${SENTINEL_CLOSE}${header}\n${out.join("\n")}\n}`;
    }
  }
}
