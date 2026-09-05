import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ForInSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `GetPNameList` + a loop testing `GetNextPName`/`JmpUndefined` -> `for (k in o)`. */
export const forIn: Pass<Stmt, ForInSite> = {
  name: "for-in",
  stage: "A",
  targets: ["05-for-in-object"],
  catalogue: [9],
  after: ["loop-cond", "for-header"],
  before: ["if-chain", "label-clean"],
  match,
  rewrite,
  check,
};
