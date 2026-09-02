// reg-split writer — docs/specs/passes/19-reg-split.md §5.
//
// For each `{ reg, webs }`: web 1 keeps `reg`; web `j` >= 2 gets `reg_j`
// (bumping the suffix past a collision, practically never hit — the emitter
// never makes a suffixed name). Every occurrence is rewritten in place via
// `transformFrame` — the same traversal `match.ts` used to enumerate them,
// called here with a real rename function, so occurrence #k in this pass
// and occurrence #k in `match`'s enumeration are the same tree position by
// construction (see `match.ts`'s doc comment). The leading `decl.names`
// entry for `reg` is replaced by the full ordered list; nothing else in the
// tree changes.
import type { Stmt } from "../ast.ts";
import { declaredNames, indexStatements, transformFrame } from "./match.ts";
import type { RegSplitMatch } from "./match.ts";
import { freeNames } from "../ast.ts";

/** `reg`'s web names, web 1 first, avoiding every name in `taken` (mutated:
 *  every name this call mints is added, so a later register's collision
 *  check sees it too). */
function namesFor(reg: string, webCount: number, taken: Set<string>): string[] {
  const names: string[] = [reg];
  taken.add(reg);
  for (let j = 2; j <= webCount; j++) {
    let suffix = j;
    let name = `${reg}_${suffix}`;
    while (taken.has(name)) {
      suffix++;
      name = `${reg}_${suffix}`;
    }
    taken.add(name);
    names.push(name);
  }
  return names;
}

export function rewrite(m: RegSplitMatch): readonly Stmt[] {
  const { splits } = m.data;
  const taken = new Set<string>([...freeNames(m.root), ...declaredNames(m.root)]);
  const nameOf = new Map<string, readonly string[]>();
  const occName = new Map<number, string>();
  for (const { reg, webs } of splits) {
    const names = namesFor(reg, webs.length, taken);
    nameOf.set(reg, names);
    for (let j = 1; j < webs.length; j++) {
      for (const occId of webs[j]!) occName.set(occId, names[j]!);
    }
  }

  const stmtIndex = indexStatements(m.root);
  let id = 0;
  const body = transformFrame(m.root, stmtIndex, () => {
    const occId = id++;
    return occName.get(occId);
  });

  const declIdx = body.findIndex((s) => s.k === "decl");
  if (declIdx < 0) return body;
  const decl = body[declIdx] as Extract<Stmt, { k: "decl" }>;
  const expanded: string[] = [];
  for (const n of decl.names) {
    const names = nameOf.get(n);
    if (names !== undefined) expanded.push(...names);
    else expanded.push(n);
  }
  if (expanded.length === decl.names.length && expanded.every((n, i) => n === decl.names[i])) return body;
  const newDecl: Stmt = { ...decl, names: expanded };
  return [...body.slice(0, declIdx), newDecl, ...body.slice(declIdx + 1)];
}
