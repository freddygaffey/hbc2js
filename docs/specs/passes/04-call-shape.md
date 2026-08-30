# 04 — `call-shape` (stage B, catalogue row **R3**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file.
Depends on `01-framework-fixes.md`; runs after `expr-rebuild` and
`global-access`.

## 1. Purpose

`src/emit/lower.ts` §7.4 routes every call that misses the `GetById`+`CallN`
fast path through `Reflect.apply(callee, thisArg, [args])`, and every `Construct`
through `Reflect.construct`. That is correct (EM-04: never `.bind`, and V8's
TypeError text follows the call shape) but unreadable. This rung restores the
call shapes whose semantics are provably identical.

Before — `19-var-hoisting/v94.hbc` `fn#1`, after `expr-rebuild` +
`global-access`:

```js
Reflect.apply(print, undefined, ["x before declaration:", undefined]);
```

After:

```js
print("x before declaration:", undefined);
```

## 2. Baseline shapes

| Emitted by | Shape |
|---|---|
| `applyCall` (`lower.ts`) | `Reflect.apply(F, T, [a…])` — `T` is `frameArgs[0]`, `undefined` for a plain call |
| `Construct` | `Reflect.construct(C, [a…])` and `Reflect.construct(C, [a…], NT)` |
| `newSites` fast path | already `new C(a…)` — nothing to do |
| `CallBuiltin functionPrototypeCall` | `__hbc_b_functionPrototypeCall(F, T, a…)` |
| `CallBuiltin functionPrototypeApply` | `__hbc_b_functionPrototypeApply(F, T, arr)` |

`Reflect.get` / `Reflect.set` (the `WithReceiver` opcodes) encode a distinct
receiver and are **never** rewritten.

## 3. AST shape the rung owns

May match/rewrite: a `call` expression whose callee is
`member(ident "Reflect", lit "apply"|"construct", computed:false)` or
`ident "__hbc_b_functionPrototypeCall"|"__hbc_b_functionPrototypeApply"`
(matched by name through `isHelperCall`, never by argument position).
**Must not touch:** any other call; a callee expression with side effects
(refuse); the argument array when it is not a literal `k:"array"`.

## 4. Matcher

Site = one statement list `L`; walk its expressions in pre-order and capture the
**first** rewritable call. Common preconditions for every rule:

* the last argument that should be the argument list is literally
  `{k:"array", elements: […]}` — a spread already materialised into an
  identifier means the arity is unknown at print time: refuse (`dynamic-args`);
* no element of that array is itself a `k:"seq"` expression;
* the callee expression `F` is `ident`, or a `member` chain over `ident`/`lit`
  (a `member` read is an effect, but it is the *first* effect in both the old
  and the new form, so the order is preserved). Anything containing a `call`,
  `new`, `assign` or `unary delete` → refuse (`impure-callee`).

**R3a — plain call.** `Reflect.apply(F, T, [a…])` where `T` is the literal
`undefined` (`{k:"lit", text:"undefined"}`) → `F(a…)`.
`T` as an *identifier* is accepted only when it is a register with exactly one
write in `ctx.fnBody` whose value is the literal `undefined` and
`nested === 0`; otherwise refuse (`unproven-this`). Additionally refuse when
`F` is a `member` (that would silently change the receiver from `undefined` to
the member's object): a `member` callee only goes through R3b.

**R3b — method call.** `Reflect.apply(member(O, P, c), R, [a…])` where `O` and
`R` are *the same identifier node* (`ident` name equality; `O` must be an
`ident`, not a nested member) → `O.P(a…)` / `O[P](a…)` per `c`. Requiring an
identifier is what makes evaluating `O` twice free.

**R3c — construct.** `Reflect.construct(C, [a…])` → `new C(a…)`. With a third
argument `NT`, rewrite only when `NT` is syntactically identical to `C`
(`new.target === C`, i.e. an ordinary `new`); otherwise refuse
(`explicit-new-target`).

**R3d — `Function.prototype` helpers.**
`__hbc_b_functionPrototypeCall(F, T, a…)` → `F.call(T, a…)`;
`__hbc_b_functionPrototypeApply(F, T, arr)` → `F.apply(T, arr)`. Here `arr` may
be any expression — `.apply` takes it as a value, so no array literal is needed.
`F` must satisfy the `impure-callee` rule above. Fewer than two arguments →
refuse (`helper-arity`).

## 5. Writer

Replace exactly that one `call` node in place; the enclosing statement and every
other expression is untouched. `src/emit/print.ts` owns precedence and
parentheses — never add them. `new C()` with zero arguments prints as `new C()`,
never `new C`.

## 6. Checker

Class: **expression-only** (ladder §4.3). `effectSequence` records a `call`/`new`
as *(callee shape, arg count)*, so R3a…R3d preserve it by construction; `check`
asserts that plus what `rewrite` assumed:

1. `expressionOnlyCheck(before, after)` — the effect sequences must be
   deep-equal, in particular the member read of `O.P` in R3b appears in both;
2. the rewritten node's argument count equals the source array's length;
3. the callee is still `impure`-free (recompute, do not trust match data);
4. R3a: `T` is the literal `undefined`, or its register still has exactly one
   `undefined` write in `before` and `nested === 0`;
5. R3b: `O` and `R` are the same identifier name in `before`;
6. R3c: no third argument, or the third is syntactically identical to `C`;
7. `parses` is run once per function by the driver (`01` F1).

## 7. Ordering, refusals, semantics, metrics

**Ordering.** `after: ["expr-rebuild", "global-access"]`, and
`before: ["spread-rest", "optional-chain", "class-recover"]` (batches 3–4):
spread call arguments and optional calls are shapes *of a call*, not of
`Reflect.apply`.

**Refuse (per-site):** `dynamic-args`, `impure-callee`, `unproven-this`,
`member-callee-with-undefined-this`, `explicit-new-target`, `helper-arity`,
`reflect-get-set` (never matched at all).

**D14 / semantics.**
* `Reflect.apply` throws `TypeError: Function.prototype.apply was called on
  undefined` when `F` is not callable; `F(a)` throws `TypeError: F is not a
  function`. The recovered shape is the one the *original source* produced, so
  this moves the output **towards** the ground truth, not away — but it is a
  message change, so any fixture whose verdict moves is a hard stop (PL-09).
* R3b changes nothing about the receiver: `O` is an identifier, evaluated twice
  in the old form and once in the new, with no observable difference.
* `Reflect.construct(C, args, NT)` with `NT !== C` is genuinely not `new C(…)`
  (it changes `new.target` and the prototype the object is created from) —
  hence R3c's refusal.

**Fixtures (red→green).** `targets: ["19-var-hoisting", "01-if-else-chain",
"32-class-basic", "21-iife-closures"]`, all five versions plus `.min`/`.obf`.
Unit tests: ≥1 positive per rule; negatives for a non-literal argument array,
an impure callee (`Reflect.apply(f(), undefined, [])`), a `member` callee with
`undefined` receiver, and `Reflect.construct` with a distinct new-target; ≥1
site `check` refuses.

**Corpus metric.** Share of emitted functions containing zero `Reflect.apply` /
`Reflect.construct`: baseline **0 %**, target **≥ 95 %** over
`tests/fixtures/constructs/**` at all five versions, and ≥ 90 % on the RN
template bundle. Remaining sites must all carry a recorded abandonment reason —
the histogram in `docs/STATUS.md` is the deliverable, not just the percentage.

**Estimated size:** ~150 lines across `match/rewrite/check`, ~200 lines of
tests.
