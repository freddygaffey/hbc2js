import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ForOfSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `IteratorBegin` + an `IteratorNext` loop with two `IteratorClose` sites -> `for (v of it)`. */
export const forOf: Pass<Stmt, ForOfSite> = {
  name: "for-of",
  stage: "A",
  targets: ["06-for-of-array", "07-for-of-iterable"],
  catalogue: [10],
  after: ["loop-cond", "for-header"],
  before: ["if-chain", "label-clean"],
  match,
  rewrite,
  check,
};
