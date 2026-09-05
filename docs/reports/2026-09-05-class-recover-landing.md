# class-recover landing (spec 24, sub-forms C1-C4) -- 2026-09-05

Branch `agent/class-recover` from `4798c23`. Rung registered, C2 landed,
C1/C3/C4 refused on F24-5 (PUSHBACK P-38).

## What landed

* **F24-1** `class` Expr + `classdecl` Stmt + `ClassMember` in
  `src/emit/ast.ts`, printed in `src/emit/print.ts` (parenthesised in bare
  statement position, computed keys `[k]`, `field` with a null value prints
  `key;`, member order is array order), and taught to `walk`, `mapExpr`,
  `mapStmts`, `countUses` and `effectSequence` in `src/passes/ast.ts`.
* **F24-2** `classSiteAt(cfg, offset)` in `src/passes/ast.ts`: the
  `CreateBaseClass`/`CreateDerivedClass` operands read straight off the
  instruction the emitter stamped on the statement. The rung keys on this and
  nothing else, so section 1.5's object-literal accessors and section 1.8's
  ES5-transpiled prototypes are refusals by construction, not by heuristic.
* **F24-4** `PassContext.functionMeta` (function-table name +
  `prohibitInvoke` role), populated in `astPassHook`.
* **`src/passes/class-recover/{index,match,rewrite,check}.ts`**, registered
  after `try-clean` and before `jsx-recover`/`fn-naming`, `versions: v >= 98
  && layout === "E"`.
* **`reg-split` fix**: its own expression walk had no `class` case, so a
  register read inside `extends` kept its pre-split name. Caught by the T2
  equivalence gate (fixture 33 DIVERGENT at record 0) before landing; fixed
  and committed with the rung.

## Rulings applied

P-21 (D23 wins -- ladder row and `src/passes/fn-naming/index.ts`'s comment
corrected), P-22 (v98+v99, layout E), P-23 (`00-LADDER.md` section 4.3 gains
a **class-shape** checker row describing section 3.4's four obligations),
scope C1-C4 only (R-C8/R-C10-style refusals left in place, recorded in the
spec's new section 7 "Landed" note). `tests/gate/passes/pipeline-speed.ts`
was not touched and the rn-template hash did not move (the bundle is v94 and
has no class opcode).

## Section 1.0 re-check (second reader)

Re-ran the measurement myself. All five class fixtures decompile at **v98**
as well as v99. `32`, `33`, `34` are byte-identical below the two header
lines; `36` differs at exactly three lines, all accessor function-table name
comments (`// fn#6 "area"` at v98 vs `// fn#6 "get area"` at v99); `35`
differs only in register allocation, with the same `Symbol("#...")` count.
Member-install, enumerable-install, prototype-link, `defineProperty` and
`new.target` counts are equal at both versions in all five. **Row 20's
upgrade to `verified` stands** -- confirmed, not taken on trust.

## Section 5 metrics

| fixture x version x variant | class heads | extends | accessors | statics | owned installs left (on) | (off) | setPrototypeOf (on) | (off) | passes=none stable |
|---|---|---|---|---|---|---|---|---|---|
| 32-class-basic v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 32-class-basic.min v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 32-class-basic.obf v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 32-class-basic v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 32-class-basic.min v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 32-class-basic.obf v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 33-class-inheritance-super v98 | 2 | 2 | 0 | 0 | 2 | 5 | 0 | 4 | yes |
| 33-class-inheritance-super.min v98 | 2 | 2 | 0 | 0 | 2 | 5 | 0 | 4 | yes |
| 33-class-inheritance-super.obf v98 | 0 | 0 | 0 | 0 | 5 | 5 | 4 | 4 | yes |
| 33-class-inheritance-super v99 | 2 | 2 | 0 | 0 | 2 | 5 | 0 | 4 | yes |
| 33-class-inheritance-super.min v99 | 2 | 2 | 0 | 0 | 2 | 5 | 0 | 4 | yes |
| 33-class-inheritance-super.obf v99 | 0 | 0 | 0 | 0 | 5 | 5 | 4 | 4 | yes |
| 34-class-static-members v98 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 34-class-static-members.min v98 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 34-class-static-members.obf v98 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 34-class-static-members v99 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 34-class-static-members.min v99 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 34-class-static-members.obf v99 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | yes |
| 35-class-private-fields v98 | 0 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | yes |
| 35-class-private-fields.min v98 | 0 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | yes |
| 35-class-private-fields v99 | 0 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | yes |
| 35-class-private-fields.min v99 | 0 | 0 | 0 | 0 | 5 | 5 | 0 | 0 | yes |
| 36-class-getters-setters v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 36-class-getters-setters.min v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 36-class-getters-setters.obf v98 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 36-class-getters-setters v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 36-class-getters-setters.min v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 36-class-getters-setters.obf v99 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | yes |
| 67-class-static-and-new v98 | 0 | 0 | 0 | 0 | 3 | 3 | 2 | 2 | yes |
| 67-class-static-and-new v99 | 0 | 0 | 0 | 0 | 3 | 3 | 2 | 2 | yes |

Abandoned-reason histogram (all fixtures, both versions, all variants):
- `no-members`: 20
- `method-not-in-body`: 16
- `group-interrupted`: 12
- `ctor-not-in-body`: 4
- `class-recover changed the effect sequence beyond the group it declared`: 4

Acceptance bar:

* **No PASS lost.** `tests/gate/decompile/equivalence.test.ts` (T2, every gate
  fixture through the real decompiler) is green: `tests 1 pass 1 fail 0`.
* **Zero rewritten sites where there is no class opcode.** Every fixture
  except 33 has identical owned-install and `setPrototypeOf` counts with the
  rung on and off; fixtures 35 and 36's non-class installs (the `Symbol("#..")`
  instance installs, the enumerable object-literal accessors) survive
  untouched.
* **Hash unchanged.** rn-template is v94: the rung's `versions` predicate
  filters it out of the pipeline entirely.

## What did not land, and why

Sub-forms C1 (32), C3 (36) and C4 (34) refuse with `ctor-not-in-body` /
`method-not-in-body`. `emitModule`'s `parentOf` nests a function under the
owner of the environment it *captures*; a class method or constructor that
captures nothing has no environment, so it is emitted at **module** level
with an `// orphan: no closure creation site was found` comment (spec 24
section 1.1 quotes exactly that output). The class body has to hold those
bodies, and they are not in `ctx.fnBody`. That is F24-5, out of scope by the
brief. PUSHBACK **P-38**, `docs/BUGS.md` row `class-recover-orphan-methods`;
the three acceptance tests stay skipped with that reason, none inverted.

`33.obf` also refuses (`group-interrupted`): the obfuscated build interleaves
the group differently. Not chased; it is a refusal, not a corruption.

## Follow-up 2026-09-05: the --split fallout of F24-5 (agent/f24-5-regress)

Landing F24-5 (26054f9) made `--split` on react-navigation-example-0.85.3 jump
from 24.26 MB to 52.43 MB, `module_523.js` from 46 KB to 28 MB, and the
segregate NO `--deps-report` navigator count from 6 to 7. The hosting rule
itself is sound and stays; the defect it exposed was in `src/split/index.ts`.

A split module file pulls in every `_fnN` it references but does not declare.
That scan ran over the printed text with comments included, and `src/emit`
prints scope-check comments that name functions by identifier, e.g.
`// emitted identifier "_fn13844" is not declared in any enclosing scope
(module > _fn0 > _fn525 > _fn5569 > _fn13837)`. The `_fn0` in that comment made
module 523 pull in the bundle's **global** function. Before F24-5 the global's
body was small, so the bug looked harmless; F24-5 made the global the lexical
parent of most of the bundle (1833 newly hosted direct children, a subtree of
15484 of the bundle's 15551 functions), so the same pull copied 26.4 MB into one
module file.

Fix: `scanFnIdentifiers(text)` (new export of `src/split/index.ts`) counts only
occurrences in code, filtering matches inside line/block comments with a
string- and template-aware comment-range scan; and the pull loop never copies
the global function into a module file. After: split 24.12 MB, `module_523.js`
back under 372 KB, navigator count 6 with the pin untouched. See
`docs/BUGS.md` row `split-comment-ref-pull` and
`tests/gate/split/comment-ref-pull.test.ts`.

The gate that landed F24-5 was green because
`tests/gate/split/segregate.test.ts`'s NO `--deps-report` test returned silently
when the bundle was absent; it now `t.skip()`s visibly.
