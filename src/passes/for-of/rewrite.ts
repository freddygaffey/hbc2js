import type { Stmt } from "../../structure/ir.ts";
import type { ForOfMatch } from "./match.ts";

/** Annotation only: the tree's blocks and edges are untouched. */
export function rewrite(m: ForOfMatch): Stmt {
  return { ...m.data.loop, form: m.data.form };
}
