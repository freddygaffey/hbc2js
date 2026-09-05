// literal-forms writer -- spec 23 section 3.2. Every sub-expression that
// survives (the operand `x`) is carried over `===`-identical -- moved, never
// rebuilt -- which is what lets the checker compare it by identity.
import type { Expr } from "../ast.ts";
import type { LiteralFormsMatch } from "./match.ts";

const typeofOf = (x: Expr): Expr => ({ k: "unary", op: "typeof ", arg: x });

export function rewriteExpr(m: LiteralFormsMatch): Expr {
  const site = m.data;
  switch (site.form) {
    case "regex":
      return { k: "regex", pattern: site.pattern, flags: site.flags };
    case "t1":
      // `!(typeof x === "<s>")` -> `typeof x !== "<s>"`.
      return { k: "bin", op: "!==", left: typeofOf(site.x), right: { k: "lit", text: site.str } };
    case "t2":
      // `typeof x === "object" && x !== null || x === null` -> `typeof x === "object"`.
      return { k: "bin", op: "===", left: typeofOf(site.x), right: { k: "lit", text: '"object"' } };
    case "t3":
      // The negation of t2's shape -> `typeof x !== "object"`.
      return { k: "bin", op: "!==", left: typeofOf(site.x), right: { k: "lit", text: '"object"' } };
  }
}
