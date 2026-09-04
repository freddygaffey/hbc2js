// optional-chain checker — docs/specs/passes/18-optional-chain.md §6.
// Recompute-and-diff, like `spread-rest`/`default-params`: nothing here
// trusts the driver's captured match data — the site is re-derived from
// `before` alone by re-running the real matcher, and the written chain is
// walked back apart and compared, link by link, against it.
//
// D14 / guard-depth (§6 item 2): `parseChainAt` (match.ts) records, per
// link, whether a `== null` guard immediately preceded that link's own
// read — every link that had one must become `optmember`/`optcall`
// (`?.`); every link that did not (the run's own opening link, when the
// compiler elided its base guard — §4's closing note) must stay plain
// `member`/`call` (`.`). That per-link "does the written node's kind match
// the recomputed guard" comparison below *is* the guard-depth check: a
// mutation that flips one guard's polarity, downgrades a guarded `?.` link
// to a plain `.`, or upgrades an unguarded link to a `?.` it never earned
// changes exactly that node's kind with nothing else in the printed source
// moving — the comparison at "chain link kind mismatch" below rejects it.
import type { Expr, Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import type { ChainLink, NullishSite } from "./match.ts";
import { match } from "./match.ts";

function sameExpr(a: Expr, b: Expr): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Walks a written chain expression apart into `(base, links)`, innermost
 *  first — the exact inverse of `rewrite.ts`'s `buildChainExpr`. Returns
 *  `null` the moment a node is not a chain link at all (any other `Expr`
 *  kind) — that ends the unwrap at the true base. */
function unwrapChain(e: Expr): { readonly base: Expr; readonly links: readonly ChainLink[] } {
  const links: ChainLink[] = [];
  let cur = e;
  for (;;) {
    if (cur.k === "optmember" || cur.k === "member") {
      links.unshift({ kind: "member", computed: cur.computed, prop: cur.prop, args: null, guarded: cur.k === "optmember" });
      cur = cur.obj;
      continue;
    }
    if (cur.k === "optcall" || cur.k === "call") {
      links.unshift({ kind: "call", computed: false, prop: null, args: cur.args, guarded: cur.k === "optcall" });
      cur = cur.callee;
      continue;
    }
    break;
  }
  return { base: cur, links };
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const fnBody = ctx.fnBody ?? before;
  const rescan = match(before, { ...ctx, fnBody });
  if (rescan === null) return { ok: false, reason: "no optional-chain site recomputed from before" };
  const site = rescan.data;

  let head = 0;
  const minLen = Math.min(before.length, after.length);
  while (head < minLen && before[head] === after[head]) head++;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }

  if (site.kind === "chain") {
    if (tailAfter - head !== 1) return { ok: false, reason: "optional-chain did not collapse the run to one statement" };
    const expectedHead = site.startIndex;
    const expectedTail = site.endIndex;
    if (head !== expectedHead || tailBefore !== expectedTail) return { ok: false, reason: "optional-chain did not replace the recomputed run" };
    const written = after[head]!;
    if (written.k !== "expr" || written.expr.k !== "assign" || written.expr.target.k !== "ident" || written.expr.target.name !== site.rRes) {
      return { ok: false, reason: "optional-chain replacement is not `rRes = <chain>`" };
    }
    const { base, links } = unwrapChain(written.expr.value);
    if (!sameExpr(base, site.base)) return { ok: false, reason: "optional-chain base is not the recomputed base" };
    if (links.length !== site.links.length) return { ok: false, reason: "optional-chain link count mismatch" };
    for (let i = 0; i < links.length; i++) {
      const got = links[i]!;
      const want = site.links[i]!;
      if (got.guarded !== want.guarded) return { ok: false, reason: "chain link kind mismatch: guardedness differs from the recomputed site" };
      if (got.kind !== want.kind) return { ok: false, reason: "chain link kind mismatch" };
      if (got.kind === "member") {
        if (got.computed !== want.computed || !sameExpr(got.prop!, want.prop!)) return { ok: false, reason: "chain link property is not reference-equal" };
      } else {
        if (got.args === null || want.args === null || got.args.length !== want.args.length || !got.args.every((a, k) => sameExpr(a, want.args![k]!))) {
          return { ok: false, reason: "chain link call arguments are not reference-equal" };
        }
      }
    }
    // Deliberately NOT `parses(after)` per site: the stage-B driver already
    // runs `parses` once per (pass, function) on the whole reconstructed body
    // (`src/passes/README.md`); doing it here too both costs a whole-list
    // print+parse on every site of a real bundle and spuriously refuses one
    // whose enclosing list holds an untouched bare `break`/`continue` (legal
    // in the real function, illegal the moment this list alone is wrapped
    // standalone — object-literal/check.ts, commit 3b0ec3a, docs/BUGS.md
    // `stage-b-per-site-parses`).
    return { ok: true };
  }

  return checkNullish(site, before, after, head, tailBefore, tailAfter);
}

function checkNullish(site: NullishSite, before: readonly Stmt[], after: readonly Stmt[], head: number, tailBefore: number, tailAfter: number): CheckResult {
  if (tailAfter - head !== 1) return { ok: false, reason: "optional-chain (??) did not collapse the run to one statement" };
  const expectedHead = site.foldedFrom ?? site.startIndex;
  const expectedTail = site.endIndex;
  if (head !== expectedHead || tailBefore !== expectedTail) return { ok: false, reason: "optional-chain (??) did not replace the recomputed run" };
  const written = after[head]!;
  if (written.k !== "expr" || written.expr.k !== "assign" || written.expr.target.k !== "ident" || written.expr.target.name !== site.rX) {
    return { ok: false, reason: "optional-chain (??) replacement is not `rX = left ?? fallback`" };
  }
  const value = written.expr.value;
  if (value.k !== "logical" || value.op !== "??") return { ok: false, reason: "optional-chain (??) did not produce a `??` node" };
  if (!sameExpr(value.left, site.left) || !sameExpr(value.right, site.fallback)) return { ok: false, reason: "optional-chain (??) operands are not reference-equal" };
  void before;
  // See the `chain` branch above: deliberately not re-checked here.
  return { ok: true };
}
