import type { Stmt } from "../../structure/ir.ts";
import type { ForInMatch } from "./match.ts";

/** Annotation only: the tree's blocks and edges are untouched. */
export function rewrite(m: ForInMatch): Stmt {
  return { ...m.data.loop, form: m.data.form };
}
