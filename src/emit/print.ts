// docs/specs/05-emitter.md §2 — the in-house printer. Byte-stable output, no
// dependency, explicit precedence so parentheses are added exactly where needed.
import type { Expr, Stmt } from "./ast.ts";

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
      return PRIMARY;
    case "member":
    case "call":
    case "new":
      return MEMBER;
    case "unary":
      return UNARY;
    case "bin":
    case "logical":
      return BINARY_PRECEDENCE[e.op] ?? 1;
    case "cond":
      return CONDITIONAL;
    case "assign":
      return ASSIGNMENT;
    case "seq":
      return SEQUENCE;
  }
}

export interface PrintOptions {
  readonly indent: string;
}

export function printProgram(body: readonly Stmt[], opts: PrintOptions = { indent: "  " }): string {
  const out: string[] = [];
  for (const s of body) printStmt(s, 0, out, opts);
  return out.join("\n") + "\n";
}

function pad(depth: number, opts: PrintOptions): string {
  return opts.indent.repeat(depth);
}

function printBody(body: readonly Stmt[], depth: number, out: string[], opts: PrintOptions): void {
  for (const s of body) printStmt(s, depth, out, opts);
}

function printStmt(s: Stmt, depth: number, out: string[], opts: PrintOptions): void {
  const p = pad(depth, opts);
  switch (s.k) {
    case "expr":
      out.push(`${p}${expr(s.expr, 0)};`);
      return;
    case "decl":
      if (s.names.length === 0) return;
      out.push(`${p}${s.kind} ${s.names.join(", ")};`);
      return;
    case "init":
      out.push(`${p}${s.kind} ${s.name} = ${expr(s.value, ASSIGNMENT)};`);
      return;
    case "if":
      out.push(`${p}if (${expr(s.test, 0)}) {`);
      printBody(s.then, depth + 1, out, opts);
      if (s.else.length > 0) {
        out.push(`${p}} else {`);
        printBody(s.else, depth + 1, out, opts);
      }
      out.push(`${p}}`);
      return;
    case "while":
      out.push(`${p}${s.label === null ? "" : `${s.label}: `}while (true) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
      return;
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
      out.push(`${p}} catch (${s.param}) {`);
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
    case "func":
      out.push(`${p}function ${s.name}(${s.params.join(", ")}) {`);
      printBody(s.body, depth + 1, out, opts);
      out.push(`${p}}`);
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
    case "member": {
      // A numeric-literal callee/object needs parentheses: `1 .x` is a syntax
      // trap, and `(1).x` is the standard workaround.
      const objText = expr(e.obj, MEMBER);
      const obj = e.obj.k === "lit" && /^-?\d/.test(e.obj.text) ? `(${e.obj.text})` : objText;
      return e.computed ? `${obj}[${expr(e.prop, 0)}]` : `${obj}.${(e.prop as { text: string }).text}`;
    }
    case "call":
      return `${expr(e.callee, MEMBER)}(${e.args.map((a) => expr(a, ASSIGNMENT)).join(", ")})`;
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
    case "cond":
      return `${expr(e.test, CONDITIONAL + 1)} ? ${expr(e.then, ASSIGNMENT)} : ${expr(e.else, ASSIGNMENT)}`;
    case "array":
      return `[${e.elements.map((x) => expr(x, ASSIGNMENT)).join(", ")}]`;
    case "object":
      return `{${e.props.map((p) => `${p.computed ? `[${p.key}]` : p.key}: ${expr(p.value, ASSIGNMENT)}`).join(", ")}}`;
    case "seq":
      return e.exprs.map((x) => expr(x, ASSIGNMENT)).join(", ");
    case "func": {
      const out: string[] = [];
      printBody(e.body, 1, out, { indent: "  " });
      return `function ${e.name ?? ""}(${e.params.join(", ")}) {\n${out.join("\n")}\n}`;
    }
  }
}
