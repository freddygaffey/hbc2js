// docs/specs/passes/29-yield-loop.md section 3 -- the framework service spec 25
// section 2 calls **F25-4** `restructureSegments`.
//
// The generator rungs thread a resume-dispatcher's arms back into the segments
// that suspend into them. In the ACYCLIC case (spec 25 section 1.4) every arm
// lands where the label/loop/try nesting it already had still holds, and the
// result is ordinary JavaScript. When the suspend graph has a BACK EDGE the
// threaded arm carries a `break L` out of the `L:`-labelled block that used to
// enclose it -- a statement that no longer parses, and whose meaning is exactly
// "jump to the head of the statements that FOLLOW `L: { ... }`".
//
// That is the whole restructuring problem, stated in the tree: the *segments*
// are the tails of the labelled blocks, and the *edges* are the labelled
// `break`s. A `break L` still inside `L:` is a forward edge and needs nothing;
// a `break L` that has escaped `L:` is a back edge to the head of `L`'s tail,
// and is realised by wrapping that tail in `L: while (true) { ... break; }` and
// spelling the edge `continue L`.
//
// Sound by construction: the only nodes introduced are a `while (true)` around
// a suffix of a statement list and a trailing `break`, and the only nodes
// rewritten are `break`s that had no binder at all. Every other edge keeps the
// program point it already targeted, because the labelled block and its tail
// both stay where they were.
import type { Stmt } from "./ast.ts";

/** The child statement lists of `s`, each with the path segment it adds. A
 *  nested `func` is deliberately opaque: it is a different frame. */
export function childLists(s: Stmt): readonly { readonly seg: string; readonly list: readonly Stmt[] }[] {
  switch (s.k) {
    case "if":
      return [
        { seg: "if-then", list: s.then },
        { seg: "if-else", list: s.else },
      ];
    case "while":
    case "do-while":
    case "for":
      return [{ seg: `loop:${s.label ?? ""}`, list: s.body }];
    case "labeled":
      return [{ seg: `labeled:${s.label}`, list: s.body }];
    case "try":
      return [
        { seg: "try-block", list: s.block },
        { seg: "try-handler", list: s.handler },
      ];
    case "switch":
      return s.cases.map((c, i) => ({ seg: `case:${i}`, list: c.body }));
    default:
      return [];
  }
}

/** Rebuild `s` with each child list replaced by `f(list, seg)`. */
export function mapChildLists(s: Stmt, f: (list: readonly Stmt[], seg: string) => readonly Stmt[]): Stmt {
  switch (s.k) {
    case "if":
      return { ...s, then: f(s.then, "if-then"), else: f(s.else, "if-else") };
    case "while":
    case "do-while":
    case "for":
      return { ...s, body: f(s.body, `loop:${s.label ?? ""}`) };
    case "labeled":
      return { ...s, body: f(s.body, `labeled:${s.label}`) };
    case "try":
      return { ...s, block: f(s.block, "try-block"), handler: f(s.handler, "try-handler") };
    case "switch":
      return { ...s, cases: s.cases.map((c, i) => ({ ...c, body: f(c.body, `case:${i}`) })) };
    default:
      return s;
  }
}

/** The label a statement binds for a `break`/`continue`, if any. */
function binds(s: Stmt): string | null {
  if (s.k === "labeled") return s.label;
  if (s.k === "while" || s.k === "do-while" || s.k === "for") return s.label;
  return null;
}

/** Labels that a `break`/`continue` inside `stmts` names but that `stmts` does
 *  not itself bind -- the back edges of this list. `continue` is recorded
 *  separately because it is never restructurable here (see R-YL3). */
function escaping(stmts: readonly Stmt[], bound: readonly string[], out: Map<string, "break" | "continue">): void {
  for (const s of stmts) {
    if ((s.k === "break" || s.k === "continue") && s.label !== null && !bound.includes(s.label)) {
      if (s.k === "continue" || !out.has(s.label)) out.set(s.label, s.k);
      continue;
    }
    const b = binds(s);
    const inner = b === null ? bound : [...bound, b];
    for (const c of childLists(s)) escaping(c.list, inner, out);
  }
}

/** Every escaping `break label` becomes `continue label`. */
function toContinue(stmts: readonly Stmt[], label: string, bound: readonly string[]): readonly Stmt[] {
  return stmts.map((s) => {
    if (s.k === "break" && s.label === label && !bound.includes(label)) return { k: "continue", label } as Stmt;
    const b = binds(s);
    const inner = b === null ? bound : [...bound, b];
    return mapChildLists(s, (list) => toContinue(list, label, inner));
  });
}

export type Restructure = { readonly ok: true; readonly body: readonly Stmt[]; readonly loops: number } | { readonly ok: false; readonly reason: string };

/**
 * Turn the back edges of `body` -- labelled `break`s that have escaped their
 * own labelled block -- into real loops. Returns the rebuilt body and how many
 * loops it introduced, or the reason it refused.
 */
export function restructureSegments(body: readonly Stmt[]): Restructure {
  let loops = 0;
  let refusal: string | null = null;
  const fix = (list: readonly Stmt[]): readonly Stmt[] => {
    let out: Stmt[] = list.map((s) => mapChildLists(s, (child) => fix(child)));
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i]!;
      if (s.k !== "labeled") continue;
      const tail = out.slice(i + 1);
      const esc = new Map<string, "break" | "continue">();
      escaping(tail, [], esc);
      const kind = esc.get(s.label);
      if (kind === undefined) continue;
      if (kind === "continue") {
        refusal ??= `a \`continue ${s.label}\` escaped its own labelled block; only a \`break\` back edge is a loop (R-YL3)`;
        continue;
      }
      loops++;
      const looped: Stmt = { k: "while", label: s.label, test: { k: "lit", text: "true" }, body: [...toContinue(tail, s.label, []), { k: "break", label: null }] };
      out = [...out.slice(0, i + 1), looped];
    }
    return out;
  };
  const fixed = fix(body);
  if (refusal !== null) return { ok: false, reason: refusal };
  const left = new Map<string, "break" | "continue">();
  escaping(fixed, [], left);
  const stuck = [...left.keys()][0];
  if (stuck !== undefined) return { ok: false, reason: `\`break ${stuck}\` still has no binder after restructuring: the back edge spans more than its own label's tail (R-YL2)` };
  return { ok: true, body: fixed, loops };
}
