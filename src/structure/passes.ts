// docs/specs/04-structurer.md §6 / 07 §2.1 — the stage-A plug-in point.
// The registry is empty at M4 (D11: baseline first); this is the extension point
// spec 04 §9's acceptance list requires to exist as real code.
import type { Diagnostic } from "../errors.ts";
import type { Pass, PassContext, AppliedRecord, AbandonedRecord } from "../passes/types.ts";
import { children } from "./ir.ts";
import type { Stmt, StructuredFunction } from "./ir.ts";
import { checkIsomorphic, reconstruct } from "./verify.ts";

export interface StagePassResult {
  readonly result: Stmt;
  readonly applied: readonly AppliedRecord[];
  readonly abandoned: readonly AbandonedRecord[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Walk the tree once per pass collecting matches, rewrite innermost-first, and
 * `check` each rewrite. A failed check abandons *that site* and leaves the
 * correct-but-ugly form (D12); a pass never aborts the function.
 */
export function applyStagePasses(fn: StructuredFunction, passes: readonly Pass<Stmt>[], ctx: PassContext): StagePassResult {
  const applied: AppliedRecord[] = [];
  const abandoned: AbandonedRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  let root = fn.root;

  for (const pass of passes) {
    const matches: { node: Stmt; match: ReturnType<Pass<Stmt>["match"]> }[] = [];
    // Post-order collection so rewrites happen innermost-first (§2.1 step 2).
    for (const node of postOrder(root)) {
      const m = pass.match(node, ctx);
      if (m !== null) matches.push({ node, match: m });
    }
    const replacements = new Map<Stmt, Stmt>();
    for (const { node, match } of matches) {
      if (match === null) continue;
      const after = pass.rewrite(match, ctx);
      const verdict = pass.check(node, after, ctx);
      if (!verdict.ok) {
        abandoned.push({ pass: pass.name, at: match.at, reason: verdict.reason ?? "check failed" });
        continue;
      }
      replacements.set(node, after);
      applied.push({ pass: pass.name, at: match.at });
    }
    if (replacements.size === 0) continue;
    const next = splice(root, replacements);
    // Whole-function guard: a stage-A pass must preserve the CFG exactly.
    const probe: StructuredFunction = { ...fn, root: next };
    const check = checkIsomorphic(probe, reconstruct(probe));
    if (!check.ok) {
      diagnostics.push({ severity: "warn", code: "W_PASS_REJECTED", message: `pass ${pass.name} changed the control-flow graph (${check.reason}); its rewrites were discarded`, context: { functionIndex: fn.functionIndex } });
      continue;
    }
    root = next;
  }

  return { result: root, applied, abandoned, diagnostics };
}

function postOrder(root: Stmt): Stmt[] {
  const out: Stmt[] = [];
  const stack: { node: Stmt; expanded: boolean }[] = [{ node: root, expanded: false }];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.expanded) {
      out.push(top.node);
      continue;
    }
    stack.push({ node: top.node, expanded: true });
    for (const c of children(top.node)) stack.push({ node: c, expanded: false });
  }
  return out;
}

/** Structural rebuild with `replacements` applied. Iterative, bottom-up. */
function splice(root: Stmt, replacements: ReadonlyMap<Stmt, Stmt>): Stmt {
  const rebuilt = new Map<Stmt, Stmt>();
  for (const node of postOrder(root)) {
    const kids = children(node);
    let changed = false;
    const newKids = kids.map((c) => {
      const r = rebuilt.get(c) ?? c;
      if (r !== c) changed = true;
      return r;
    });
    let out = changed ? withChildren(node, newKids) : node;
    const replacement = replacements.get(node);
    if (replacement !== undefined) out = replacement;
    rebuilt.set(node, out);
  }
  return rebuilt.get(root) ?? root;
}

function withChildren(node: Stmt, kids: readonly Stmt[]): Stmt {
  switch (node.k) {
    case "seq":
      return { k: "seq", body: kids };
    case "labeled":
      return { ...node, body: kids[0]! };
    case "loop":
      return { ...node, body: kids[0]! };
    case "if":
      return { ...node, then: kids[0]!, else: kids[1]! };
    case "switch":
      return { ...node, cases: node.cases.map((c, i) => ({ ...c, body: kids[i]! })), default: kids[node.cases.length]! };
    case "try":
      return { ...node, body: kids[0]!, handler: kids[1]! };
    default:
      return node;
  }
}
