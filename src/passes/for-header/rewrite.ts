import type { Stmt } from "../../structure/ir.ts";
import type { ForMatch } from "./match.ts";

/** Annotation only: the tree's blocks and edges are untouched. */
export function rewrite(m: ForMatch): Stmt {
  const { loop, init, step } = m.data;
  return { ...loop, form: { ...loop.form!, kind: "while", init, step } };
}
