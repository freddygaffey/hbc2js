# 23 — `arguments-form` (stage B) + `literal-forms` (stage B)

**Catalogue rows:** `R10` (`arguments-form`, readability table — it recognises
the *emitter's* reification helper, not a Hermes idiom; row 16
[arguments-object.md](../../lowering/arguments-object.md) stays the lowering
provenance and is `✅ single-version`, which PL-06 refuses, exactly the reason
`label-clean` has `R8` rather than row 5); 29 (regex literal, new with this
spec) and 30 (`TypeOfIs` mask, new with this spec) for `literal-forms`.
**Fixtures:** `42-rest-params`, `49-arguments-object` (`arguments-form`);
`45-regex-literals`, `46-bigint-arithmetic`, `47-typeof-instanceof-in`,
`55-typeof-is-masks` (`literal-forms`).
**Ladder rows:** `00-LADDER.md` §1.x `arguments-form` (batch 4, all versions)
and `literal-forms` (batch 4, all versions).
**Ownership:** §3.1 `arguments-form` owns exactly the call expression
`__hbc_arguments(arguments)` — nothing else, never a bare `arguments`, never a
parameter, never the helper's own definition. §3.2 `literal-forms` owns the
`new RegExp(<string>, <string>)` node the emitter built from `CreateRegExp`
(and only that one: F23-2 provenance) and the `TypeOfIs` mask expansion
`!(typeof x === "s")` / `typeof x === "object" && x !== null || x === null`.

One spec, two rungs, because both are *surface* rungs on emitter output: the
bytecode fact is already fully decoded at M4 and what remains is the JS form
the emitter chose to be safe in. Neither rung reads a new byte; both are
provable from the emitted AST plus one provenance bit.

---

## 1. Idiom evidence (measured 2026-09-05, this worktree)

Method: `node src/cli.ts disasm <fixture>/<vNN>.hbc` for opcode counts and
`node src/cli.ts decompile <fixture>/<vNN>.hbc` for output; counts are
occurrences in the whole emitted module. Every quoted line below is real
current output, not an illustration.

### 1.1 `arguments` — the reification helper (rung `arguments-form`)

Opcodes, all five versions (`49-arguments-object` / `42-rest-params`):

| Version | `Reify*` | `GetArgumentsLength` | `GetArgumentsPropByVal*` |
|---|---|---|---|
| 84 | 2 / 0 | 3 / 3 | 2 / 2 |
| 94 | 2 / 0 | 3 / 3 | 2 / 2 |
| 96 | 2 / 0 | 3 / 3 | 2 / 2 |
| 98 | 3 (`Loose`) / 0 | 3 / 3 | 2 (`Loose`) / 2 (`Loose`) |
| 99 | 3 (`Loose`) / 0 | 3 / 3 | 2 (`Loose`) / 2 (`Loose`) |

The opcode family is version-uniform modulo the v98 `Loose`/`Strict` split,
and `src/emit/lower.ts`'s `--- arguments ---` switch already maps all of them
onto two emitted shapes:

* **S1 — reification.** `Reify*` becomes a helper call
  (`src/emit/lower.ts:809`, `src/runtime/helpers.ts` §8):
  `r0 = __hbc_arguments(arguments);` (49 v94 `toArray`). The helper builds an
  **unmapped** copy, because Hermes never aliases parameters and re-using the
  emitted function's own sloppy-mode `arguments` would invent an aliasing the
  bytecode does not have (docs/EQUIVALENCE.md §5.2).
* **S2 — direct reads.** `GetArgumentsLength` / `GetArgumentsPropByVal*`
  already emit `arguments.length` and `arguments[r2]` with no helper
  (49 v94 `sumAll`) — **not owned by this rung**, there is nothing to raise.

So the whole readability gap is S1, and it is worth closing: the RN template
(`tests/fixtures/bundles/rn-template-0.72/index.android.hbc`, v96, default
pipeline) prints **48** `__hbc_arguments(arguments)` sites and 194 S2 reads.

The refusal case is in the same fixture, at every version (49, default
pipeline, 1 site at 84/94/96/98/99):

```js
function aliasDemo(a1, a2) {
  __hbc_arguments(arguments)[0] = "changed-via-arguments";
  return a1;
}
```

Rewriting that call to a bare `arguments` would change the answer: the emitted
function is sloppy (`src/emit/function.ts:555` emits `"use strict"` only for a
`strictMode` header) and has two simple parameters, so its `arguments` object
**is** mapped in JS and the store would land in `a1`. Hermes's own object is
unmapped, and the fixture's `expected.txt` is Hermes's answer. This is
catalogue row 16's "mapped-arguments aliasing" case and §4.1's refusal `R-A3`.

The safe cases are in the same two fixtures: `toArray()` (49) has **no**
parameters, and `combine(a1, ...r0)` (42) has a **rest** parameter — a JS
`arguments` object is unmapped in both, by construction, whatever the code
does with it.

*Latent bug this rung also fixes* (docs/BUGS.md row 2026-09-05
`arguments-identity`): the helper returns a **fresh** copy per call, so two
`Reify*` in one function (49 at v98/v99 has 3 reify sites) print two distinct
objects where Hermes reifies one. `var a = arguments, b = arguments; a === b`
is `true` under Hermes and `false` in today's output. No fixture asserts it
today; §5's acceptance list adds one.

### 1.2 Regex literals (rung `literal-forms`, sub-form **L-R**)

`CreateRegExp` count in `45-regex-literals`: **6 at v94, v96, v98, v99**
(no v84 build: named capture groups, `versions.txt`). `src/emit/literals.ts`
`regExpExpr` prints `new RegExp(<pattern>, <flags>)` from the two string-table
ids and never decodes `regExpStorage`; its own doc comment already nominates
the literal form as a stage-B pass. Output is identical at all four versions:

```js
regExp = new RegExp("(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})", "");
regExp2 = new RegExp("\\b\\w+\\b", "g");
regExp6 = new RegExp(",", "");
```

RN template: **49** `new RegExp(` sites, including the two shapes that decide
the escaping rule — `new RegExp("\\/", "g")` (the pattern text already carries
`\/`, because Hermes stores the *source* text of the literal the programmer
wrote) and `new RegExp("^https?:\\/\\/.*?\\/", "")`.

### 1.3 BigInt literals (sub-form **L-B**) — already lowered, no rung work

`46-bigint-arithmetic` has 6 `LoadConstBigInt` at v94/96/98/99 (no v84 build),
and `src/emit/lower.ts:343` already routes them through
`literals.ts:bigIntLiteral`. Current output, default pipeline **and**
`--passes=none`:

```js
limit = 9007199254740993n;
print("loose equality allowed:", 5n == 5);
```

There is nothing left to raise: the ladder row's "BigInt table -> `123n`" was
already delivered by M4's emitter. **This spec ships no BigInt matcher** and
`literal-forms` declares no BigInt catalogue row (docs/PUSHBACK.md P-12). The
only BigInt-shaped residue in output is `Inc`/`Dec`'s deliberate
`typeof r2 === "bigint" ? r2 + 1n : +r2 + 1` guard (`lower.ts:368`), which is
a *semantic* lowering of `ToNumeric` and must not be collapsed by a
readability rung.

### 1.4 `TypeOfIs` masks (sub-form **L-T**)

The opcode exists only from HBC 98 (`55-typeof-is-masks`: 5 `TypeOf` at v94
and v96; 3 `TypeOfIs` + 9 `JmpTypeOfIs` at v98 and v99 — identical operands at
both). The mask is a `TypeOfIsTypes` bitset from the MIT Hermes source
`include/hermes/FrontEndDefs/Typeof.h`, vendored per pin and generated into
`src/tables/generated/typeofis-*.ts`; all three pins that have it
(`hbc98-late`, `hbc99-feb2026`, `hbc99-mar2026`) agree on the bit order:

| Bit | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| Member | Undefined | Object | String | Symbol | Boolean | Number | Bigint | Function | Null |
| Value | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |

Nine members, exhaustive over JS values (`typeof`'s eight results with
`object` split into `Object` and `Null`), so the full mask is 511 and a `!==`
test compiles to the complement. Masks actually present in the fixture at
v98 **and** v99: `4` (String), `32`, `16`, `1`, `128`, `8`, `64` (single
bits), `258` (= Object|Null), `507` (= 511-4), `383` (= 511-128), `503`
(= 511-8).

`src/emit/typeofis.ts` decodes every one of them correctly (review M4-H2) but
prints the bitset shape, not the source shape. The evidence that the source
shape is recoverable is the **same fixture at v94/v96**, where no such opcode
exists and the compiler emits `TypeOf` + a comparison — so the emitter already
prints exactly what the programmer wrote:

| Source | v94 / v96 output | v98 / v99 output |
|---|---|---|
| `typeof x !== 'string'` (mask 507) | `return typeof a1 !== "string";` | `return !(typeof a1 === "string");` |
| `typeof x === 'object'` (mask 258) | `return typeof a1 === "object";` | `return typeof r1 === "object" && r1 !== null \|\| r1 === null;` |
| `typeof x !== 'function'` (mask 383) | `return typeof a1 !== "function";` | `return !(typeof a1 === "function");` |
| `typeof v === 'symbol' ? …` (mask 503 guard) | `if (typeof a1 !== "symbol") {` | `if (!(typeof a1 === "symbol")) {` |

Counts at v98 and v99 (both `--passes=none` and default, i.e. pure emitter
output): 3 `!(typeof ` and 2 `… !== null || …`; at v94/v96, 0 and 0.
**The rung's whole job is to make v98/v99 print what v94/v96 already print**,
which is also the checkable acceptance property. `47-typeof-instanceof-in`
adds the negative side: its `typeof` uses compile to plain `TypeOf` at every
version (`typeof r6.neverDeclared`, `typeof arr3`), and the rung must leave
every one of them alone.

---

## 2. Pass placement

Both rungs are **stage B**, in the structure-recovery block (D23), registered
after `object-literal` and before `jsx-recover` — i.e. before every renaming
rung, so `reg-split`/`var-naming` never see a name this rung is about to
delete, and after every rung that changes an expression's shape.

```
arguments-form:  { stage: "B", catalogue: ["R10"],
                   after:  ["expr-rebuild", "spread-rest"],
                   before: ["fn-naming", "reg-split", "var-naming"] }
literal-forms:   { stage: "B", catalogue: [29, 30],
                   after:  ["expr-rebuild"],
                   before: ["fn-naming", "reg-split", "var-naming"] }
```

* `after: ["expr-rebuild"]` is injected by PL-11 anyway; declaring it is
  documentation. Both matchers need the folded expression: unfolded, the
  reify call is `r0 = __hbc_arguments(arguments);` on its own line and the
  `TypeOfIs` expansion is spread over several register stores.
* `after: ["spread-rest"]` on `arguments-form` is **load-bearing**: the rest
  parameter in `function combine(a1, ...r0)` is `spread-rest`'s work
  (`CopyRestArgs`), and a rest parameter is precisely what makes an
  `arguments` object unmapped. Matching before it would refuse fixture 42's
  safe sites for a reason that is no longer true afterwards.
* Neither rung may declare `after`/`before` on a rung that is not registered
  (`enabledPasses` throws `E_PASS_ORDER`), so the names above are exactly the
  rungs that exist today.
* Version restriction: **none** (`Pass.versions` absent) for either rung. The
  shapes are emitter output; L-T simply finds nothing at v84-96 because the
  opcode does not exist there, and that is asserted rather than assumed.

### Framework changes

* **F23-1** (`src/passes/types.ts`): `PassContext.fnParams?: { readonly names:
  readonly string[]; readonly simple: boolean }` for stage B — the emitted
  parameter identifiers of the current function (`a1…aN`,
  `src/emit/function.ts:265`) and whether the list is *simple* (no rest, no
  default, no destructuring pattern). Populated where `fnBody` is (F1). Every
  clause of §4.1 that talks about parameters reads this and nothing else; a
  context without `fnParams` is a refusal, never a guess.
* **F23-2** (`src/emit/ast.ts` + `src/emit/literals.ts`): a
  `readonly fromRegExpTable?: true` provenance flag on the `new` node
  `regExpExpr` builds. It is the *only* way to tell the emitter's
  `CreateRegExp` lowering from a genuine source-level `new RegExp(a, b)`
  (which is a real global read that a literal would erase — see §4.2 R-L1).
  Printing ignores it; `sameShape`/`effectSequence` ignore it.
* **F23-3** (`src/emit/ast.ts` + `src/emit/print.ts`): a
  `{ k: "regex"; pattern: string; flags: string }` expression node, printed as
  `/<pattern>/<flags>` at *primary* precedence (never parenthesised as a
  member base: `/x/g.test(s)` is valid JS). It is a new node kind rather than
  a raw `lit`, so the checker can compare structure and so the printer owns
  the one dangerous case (`//` opening a comment, §4.2).
* **F23-4** (not in this batch, listed in §6): pruning the now-unused
  `__hbc_arguments` helper from the prelude. `helpersUsed` is fixed during
  emit, before stage B runs, so a module whose every reify site was rewritten
  still prints the 5-line helper. Harmless, and out of scope.

---

## 3. Ownership, writer, checker

### 3.1 `arguments-form`

**Site.** The whole current function body (F1): `match(list, ctx)` returns
`null` unless `list === ctx.fnBody`. One site per function, because the
safety argument is whole-function (a store to `a1` anywhere in the function is
observable through a mapped `arguments` read anywhere else).

**Owns.** Every expression `{ k: "call", callee: ident "__hbc_arguments",
args: [ident "arguments"] }` in that body, replaced in place by
`{ k: "ident", name: "arguments" }`. Nothing else changes: not the argument
list, not the helper definition (which lives in the prelude, outside any
function body), not an `arguments` that is already bare, not a parameter.

**Writer.** A single traversal replacing the matched call nodes; every other
node is returned `===`-identical. `Match.data` is the list of replaced paths.

**Checker** (expression-only class, `00-LADDER.md` §4.3):

1. **Undo.** Re-wrap each declared path in `after` with the helper call; the
   result must be deep-equal to `before`. Any other edit fails here.
2. `effectSequence(before)` deep-equals `effectSequence(after)` — the rewrite
   removes a *call* effect, so the checker's effect model must treat
   `__hbc_arguments(x)` as pure (it is: a pure function of its argument, no
   store, no throw for the one argument shape the matcher accepts) and this
   equivalence must be stated in `check.ts`, not assumed. Plus `parses(after)`.
3. **Independent re-derivation.** Recompute §4.1's whole-function predicate
   from `before` alone and require it to hold; recompute `freeNames(after) ⊆
   freeNames(before)`; assert `after` contains no `__hbc_arguments` call and
   no new `arguments` outside the replaced paths.

### 3.2 `literal-forms`

**Sites.** L-R: one `new` node carrying `fromRegExpTable`. L-T: one `unary !`
node, or one `logical ||` node, matching the shapes in §4.2. All three are
local expression rewrites; no statement moves, no name is introduced or
dropped, so the rung needs no whole-function context and takes the ordinary
per-node site (post-order, innermost first).

**Writer.** L-R replaces the `new` node with a `regex` node (F23-3). L-T
replaces the matched node with the `bin`/`logical` node named in §4.2. In all
cases every sub-expression that survives is carried over `===`-identical (the
operand `x` is *moved*, never rebuilt), which is what lets the checker compare
it by identity.

**Checker** (expression-only):

1. `parses(after)` and `effectSequence(before)` deep-equals
   `effectSequence(after)`. Both L-R and L-T are effect-neutral: L-R deletes
   the `new RegExp` *construction* effect, so — exactly as in 3.1 — `check.ts`
   states the equivalence (`new RegExp(p, f)` with literal `p`/`f` and a
   `/p/f` literal both allocate a fresh RegExp with the same `source`,
   `flags`, `lastIndex`) rather than letting the generic model wave it
   through.
2. **L-R re-derivation.** Independently recompute the literal body from the
   `before` node's string arguments and require it to equal the `after` node's
   `pattern`; then assert the round trip
   `new RegExp(after.pattern, after.flags).source === new RegExp(before.args[0],
   before.flags).source` and the same for `.flags`. A failure is a refusal,
   never a warning.
3. **L-T re-derivation.** Rebuild the expected `after` from `before` by the
   §4.2 table and deep-equal it; assert the operand sub-tree is `===` the one
   in `before` (no re-evaluation of a possibly-impure expression was
   introduced, and no extra evaluation was removed: the `x` count changes from
   2 or 3 to 1, which is the *point* and is sound only because the operand is
   a pure register/identifier read — condition P-T3).

---

## 4. Refusals

Each is a distinct counted `abandoned` reason.

### 4.1 `arguments-form`

* **R-A0 `already-bare`** — the body contains no `__hbc_arguments(arguments)`
  call: `match` returns `null` (PL-08 fixed point, checked first, before any
  context read).
* **R-A1 `no-fn-params`** — `ctx.fnParams` (F23-1) is absent. Never guess an
  arity.
* **R-A2 `helper-escapes`** — the identifier `__hbc_arguments` appears in the
  body in any position other than the callee of an accepted call, or an
  accepted call's argument is not the bare identifier `arguments`. (The
  emitter only ever writes the one shape; an obfuscated or hand-edited input
  might not.)
* **R-A3 `mapped-arguments`** — the mapping is live, i.e. **all** of:
  the function is sloppy (no `"use strict"` directive in its own prologue and
  none in any enclosing emitted function), `ctx.fnParams.simple` is `true`,
  and `ctx.fnParams.names.length > 0`; **and** the mapping is observable, i.e.
  either (a) some parameter name is the target of an assignment or update
  anywhere in the body, or (b) a replaced call's value is used as anything
  other than the object of a *read* member expression — in particular as the
  object of an assignment target (`__hbc_arguments(arguments)[0] = v`,
  fixture 49 `aliasDemo`), or as a call argument, or stored into a variable
  that later escapes. Conservative and deliberately coarse: a bare
  `Array.prototype.slice.call(<reified>)` (49 `toArray`) is an escape, and is
  accepted only because that function has **zero** parameters and so fails the
  first half of R-A3.
* **R-A4 `arguments-shadowed`** — the body (or an enclosing emitted function
  up to the module wrapper) declares a variable, parameter or function named
  `arguments`, so a bare `arguments` would not resolve to the arguments
  object.
* **R-A5 `nested-capture`** — a nested function inside the body refers to
  `arguments`. The emitted nested function has its own `arguments`, so
  replacing an outer helper call is fine, but a nested *reference to the
  helper's result* (`identUses(...).nested > 0`) is not: refuse.
* **R-A6 `generator-body`** — the function is an opcode-generator body
  (`src/emit/function.ts:557` hoists `var __args = arguments`): the reified
  object of the *outer* generator function is not the inner body's
  `arguments`. Refuse until `yield-recovery` lands and the shape is re-read.

### 4.2 `literal-forms`

**L-R (regex).** Accept `{ k: "new", fromRegExpTable: true }` whose two
arguments are string literals `p` and `f`. Body is `new RegExp(p, f).source`
— the ES `EscapeRegExpPattern` result, which is *defined* to be re-parsable as
a literal with the same behaviour, and which already handles the empty pattern
(`(?:)`) and every unescaped `/`. Refuse on:

* **R-L1 `no-provenance`** — the `new RegExp` node has no `fromRegExpTable`
  flag: it is a genuine source-level `new RegExp(...)` whose global read
  (`RegExp` could be shadowed or replaced) a literal would erase.
* **R-L2 `non-literal-args`** — either argument is not a string literal
  (cannot happen from the emitter; refuse rather than assume).
* **R-L3 `not-constructible`** — `new RegExp(p, f)` throws in the decompiler's
  own runtime (a flag Hermes accepts and Node does not, a pattern only Hermes
  parses). Keep the `new RegExp` call: it is what the bytecode says, and it
  will still throw at the same point in the decompiled program.
* **R-L4 `round-trip-differs`** — `new RegExp(body, f)` does not reproduce
  `.source` and `.flags` exactly. This is the single check that makes the
  escaping rule a proof rather than a convention; it also catches any future
  Node change to `EscapeRegExpPattern`.
* **R-L5 `unprintable`** — `body` contains a raw line terminator (`\n`, `\r`,
  U+2028, U+2029) or starts with `*` (`/*` opens a comment). `.source` escapes
  line terminators already, so R-L5 is a belt-and-braces assertion in the
  printer's own terms; if it ever fires, the printer would have emitted
  something that does not parse.

**L-T (typeof masks).** Three rules, each keyed on the exact shape
`src/emit/typeofis.ts` produces, with `x` the shared operand sub-tree:

| # | Before | After | Mask that produced it |
|---|---|---|---|
| T1 | `!(typeof x === "<s>")` | `typeof x !== "<s>"` | complement of a single non-`Object` bit (507, 383, 503, …) |
| T2 | `typeof x === "object" && x !== null \|\| x === null` | `typeof x === "object"` | 258 = Object\|Null |
| T3 | `!(typeof x === "object" && x !== null \|\| x === null)` | `typeof x !== "object"` | 253 = 511-258 |

Preconditions and refusals:

* **P-T1** the string literal in T1 is one of the eight `typeof` results, and
  in T2/T3 the shape is *exactly* the printed disjunction above, association
  included (`(a && b) || c`).
* **P-T2** every occurrence of `x` in the matched node is deep-equal.
* **P-T3 / R-T1 `impure-operand`** — `x` is not an identifier, a register
  read or a plain non-computed member chain over those. T2/T3 evaluate `x`
  twice before and once after; that is only sound for a pure operand. (The
  emitter's own contract, `typeofis.ts`'s doc comment, is that every call site
  passes a register read — so this refusal should never fire on emitter
  output, and firing it is a signal, not a nuisance.)
* **R-T2 `multi-bit-mask`** — anything else the mask decoder can print: a
  genuine multi-category disjunction (`typeof x === "string" || typeof x ===
  "number"`), `lit("true")`/`lit("false")` for the 0/full masks. Those are
  already the clearest available form; the rung leaves them alone.
* **R-T3 `not-mask-shaped`** — a `!`/`||` that merely looks similar, e.g. a
  hand-written `!(typeof x === "string")` in a v94 module (no `TypeOfIs`
  there). Note the rung cannot tell that apart from a mask expansion and
  **will** rewrite it; this is sound (`!(a === b)` and `a !== b` are the same
  for `typeof`'s string result at every version) and is the reason T1 is
  restricted to a `typeof` left operand rather than to any `===`.

---

## 5. Acceptance tests

`tests/gate/passes/arguments-form.test.ts` and
`tests/gate/passes/literal-forms.test.ts`, shipped with this spec, ahead of
the implementation: every test that needs a rung is `{ skip: SKIP }` and
imports it through a non-literal dynamic import, so both files typecheck and
run green while `src/passes/<rung>/` does not exist. The orchestrator lifts
the skips in the landing commit. Rung-owned properties only — counts, shapes,
regexes, hand-built ASTs — never a whole-output comparison against a shared
fixture (CLAUDE.md testing rules, `docs/CONSOLIDATION.md` §B item 7).

Non-skipped today (and still true after the rungs land):

* the `--passes=none` baseline shapes of §1 (PL-05 makes them permanent):
  `__hbc_arguments(` at 84/94/96/98/99 of fixture 49, 6 `new RegExp(` at
  94/96/98/99 of fixture 45, 3 `!(typeof ` and 2 Object|Null disjunctions at
  v98/v99 of fixture 55 with none at v94/v96;
* the refusal side on the default pipeline: fixture 49's
  `__hbc_arguments(arguments)[0] = ` survives at every version (R-A3);
* the mask bit table of §1.4 against `src/tables/generated/typeofis-*.ts`, and
  the decoding of every mask observed in the fixture;
* the L-R escaping rule as a pure property of the six fixture patterns
  (`new RegExp(new RegExp(p, f).source, f).source === new RegExp(p, f).source`);
* the catalogue rows (`R10`, 29, 30) exist and are `✅ verified` (PL-06 would
  otherwise refuse the rungs at registration).

Skipped until the rungs exist: registry shape and ordering; PL-08 fixed point
on an already-rewritten body; fixture 49/42 replacement counts per version;
`aliasDemo` refusal with the rung *on*; fixture 45 literal counts and the
`\/` re-escape; fixture 55 v98/v99 output becoming its own v94/v96 output; the
`47-typeof-instanceof-in` no-op; the identity regression (§1.1) as a new
construct fixture the implementer builds via `tests/fixtures/build.sh`.

**Metrics to report at landing**, per fixture x version x variant: reify sites
before/after, `new RegExp` sites before/after, `!(typeof `/Object|Null sites
before/after, each rung's abandoned-reason histogram, and the RN-template
numbers (48 reify, 49 regex today). Acceptance bar: no fixture loses its PASS
verdict; `--passes=none` byte-identical; zero rewritten sites in
`47-typeof-instanceof-in` and in `46-bigint-arithmetic`.

---

## 6. Needs Fred / open questions

1. **Golden hash regeneration.** `tests/gate/passes/pipeline-speed.test.ts`
   pins the passes-on rn-template output hash
   (`fa54d8f2…`). Both rungs change that bundle's output (48 reify sites, 49
   regex sites; no `TypeOfIs` at v96), so the hash must be regenerated in the
   landing commit. **Regeneration is Fred's call, batched with the other
   queued goldens** — this spec must not be read as pre-approval, and the
   implementer must not touch that file. Nothing else in the gate pins whole
   output for these fixtures.
2. **PUSHBACK P-12 — the BigInt sub-form does not exist.** §1.3: BigInt table
   literals are already printed as `123n` by M4's emitter, at every version
   that has them. The ladder row and the brief both ask for a rung; there is
   no work. Confirm the row can be struck rather than left as an unbuilt
   promise.
3. **F23-4, the unused helper.** After `arguments-form` clears a module's last
   reify site the prelude still prints `__hbc_arguments`. Pruning it means
   recomputing `helpersUsed` after stage B, which is a small emitter change
   with a whole-module blast radius. Proposed: not in this batch; a follow-up
   rung-independent change with its own test.
4. **How coarse should R-A3 be?** As specified, any sloppy function with at
   least one simple parameter *and* any parameter write or any escape of the
   reified object refuses. On the RN template that is measurable before
   implementation; if it refuses most of the 48 sites, the alternative is a
   narrower dataflow (per-index liveness of each parameter against each
   `arguments[k]` access), which is a much larger rung. Measure first, and
   report the split before widening.
5. **Row 16's confidence.** `arguments-form` cites the readability row `R10`
   precisely so it does not depend on upgrading row 16 (`✅ single-version`)
   whose Notes make a semantic claim about aliasing that contradicts
   `src/runtime/helpers.ts` §8 ("Hermes does not alias parameters"). Someone
   should re-read row 16 against an executed VM run and correct the row or the
   helper comment; it is not this spec's to settle.
