// docs/specs/07-pass-ladder.md §2.1 — the stage-A driver.
//
// One pass at a time, innermost site first. Each accepted site is spliced into
// the whole tree and the spec 04 §5 round-trip (`reconstruct` + `checkIsomorphic`)
// is re-run on the *whole function*: a rewrite that changes the CFG is abandoned
// at that site only (D12), never aborting the function. A pass that throws is
// `E_PASS_CRASH` (PL-04): an escaping exception means the pass is unsound.
import type { Diagnostic } from "../errors.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { children } from "../structure/ir.ts";
import type { Stmt, StructuredFunction } from "../structure/ir.ts";
import { checkIsomorphic, reconstruct } from "../structure/verify.ts";
import type { AbandonedRecord, AppliedRecord, Pass, PassContext } from "./types.ts";

export interface ApplyResult {
  readonly fn: StructuredFunction;
  readonly applied: readonly AppliedRecord[];
  readonly abandoned: readonly AbandonedRecord[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Guard against a matcher that keeps producing fresh matches (PL-08 says it must not). */
const MAX_SITES_PER_PASS = 10_000;

export function applyPasses(fn: StructuredFunction, passes: readonly Pass<Stmt>[], base: Omit<PassContext, "applied" | "structured" | "parentOf">): ApplyResult {
  const applied: AppliedRecord[] = [];
  const abandoned: AbandonedRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const appliedNames: string[] = [];
  let current = fn;

  for (const pass of passes) {
    // Sites the pass matched but whose rewrite failed a check. Keyed by node
    // identity: the node survives untouched in the tree, so it is seen again on
    // the next walk and must not be retried forever.
    const refused = new Set<Stmt>();
    // W_PASS_REFUSED: distinct (reason -> site identities) this pass has
    // reported refusing for the current function, deduped so a site a
    // matcher is asked about again (PL-08 re-scans) is counted once.
    const refusals = new Map<string, Set<unknown>>();
    let parents = parentMap(current.root);
    const ctx: PassContext = {
      ...base,
      applied: appliedNames,
      structured: current,
      parentOf: (node) => parents.get(node as Stmt) ?? null,
      refuse: (node, reason) => {
        let sites = refusals.get(reason);
        if (sites === undefined) refusals.set(reason, (sites = new Set()));
        sites.add(node);
      },
    };
    let firedHere = false;
    for (let guard = 0; guard < MAX_SITES_PER_PASS; guard++) {
      const site = firstMatch(current.root, pass, ctx, refused);
      if (site === null) break;
      const { node, match } = site;
      let after: Stmt;
      let verdict: ReturnType<Pass<Stmt>["check"]>;
      try {
        after = pass.rewrite(match, ctx);
        verdict = pass.check(node, after, ctx);
      } catch (e) {
        throw new Hbc2jsError(ErrorCode.E_PASS_CRASH, `pass "${pass.name}" threw at fn#${match.at.functionIndex} @${match.at.offset}: ${e instanceof Error ? e.message : String(e)}`, { functionIndex: match.at.functionIndex, section: "passes" });
      }
      if (!verdict.ok) {
        refused.add(node);
        abandoned.push({ pass: pass.name, at: match.at, reason: verdict.reason ?? "check failed" });
        continue;
      }
      const root = splice(current.root, node, after);
      const probe: StructuredFunction = { ...current, root };
      const iso = checkIsomorphic(probe, reconstruct(probe));
      if (!iso.ok) {
        refused.add(node);
        abandoned.push({ pass: pass.name, at: match.at, reason: `round-trip: ${iso.reason}` });
        continue;
      }
      current = probe;
      parents = parentMap(current.root);
      applied.push({ pass: pass.name, at: match.at });
      firedHere = true;
    }
    if (firedHere) appliedNames.push(pass.name);
    for (const [reason, sites] of refusals) {
      diagnostics.push({ severity: "info", code: "W_PASS_REFUSED", message: `pass ${pass.name} refused ${sites.size} site(s): ${reason}`, context: { pass: pass.name, reason, count: sites.size } });
    }
  }
  for (const a of abandoned) {
    diagnostics.push({ severity: "info", code: "W_PASS_ABANDONED", message: `pass ${a.pass} left fn#${a.at.functionIndex} @${a.at.offset} as is: ${a.reason}`, context: { functionIndex: a.at.functionIndex, offset: a.at.offset } });
  }
  return { fn: current, applied, abandoned, diagnostics };
}

/** Innermost (post-order) node the pass matches and has not refused. */
function firstMatch(root: Stmt, pass: Pass<Stmt>, ctx: PassContext, refused: ReadonlySet<Stmt>): { node: Stmt; match: NonNullable<ReturnType<Pass<Stmt>["match"]>> } | null {
  for (const node of postOrder(root)) {
    if (refused.has(node)) continue;
    let m: ReturnType<Pass<Stmt>["match"]>;
    try {
      m = pass.match(node, ctx);
    } catch (e) {
      throw new Hbc2jsError(ErrorCode.E_PASS_CRASH, `pass "${pass.name}" threw in match: ${e instanceof Error ? e.message : String(e)}`, { functionIndex: ctx.functionIndex, section: "passes" });
    }
    if (m !== null) return { node, match: m };
  }
  return null;
}

export function postOrder(root: Stmt): Stmt[] {
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

function parentMap(root: Stmt): Map<Stmt, { parent: Stmt; index: number }> {
  const out = new Map<Stmt, { parent: Stmt; index: number }>();
  for (const node of postOrder(root)) for (const [i, c] of children(node).entries()) out.set(c, { parent: node, index: i });
  return out;
}

/** Replace `target` (by identity) with `replacement`, rebuilding the spine. */
export function splice(root: Stmt, target: Stmt, replacement: Stmt): Stmt {
  if (root === target) return replacement;
  const kids = children(root);
  let changed = false;
  const next = kids.map((c) => {
    const r = splice(c, target, replacement);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? withChildren(root, next) : root;
}

function flat(s: Stmt): Stmt[] {
  return s.k === "seq" ? s.body.flatMap(flat) : [s];
}

export function withChildren(node: Stmt, kids: readonly Stmt[]): Stmt {
  switch (node.k) {
    case "seq":
      // Keep sequences flat: a rewrite that returns `seq[loop, exit]` in place
      // of a loop must not hide the loop's preceding sibling from the next pass.
      return { k: "seq", body: kids.flatMap(flat) };
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
