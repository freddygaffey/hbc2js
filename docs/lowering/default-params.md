# Default parameters — `undefined`-check, evaluated per-call

**Fixtures:** `39-destructuring-params`, `51-default-params`
**Confidence:** ✅ verified (v94, v99, `-O0`)

## 1. Source

```js
function greet(name, greeting = 'Hello, ' + name + '!') { return greeting; }
function chainedDefaults(a = 1, b = a + 1, c = a + b) { return a+','+b+','+c; }
```

## 2. Bytecode

The parameter is always loaded first via ordinary `LoadParam`; the default
expression is guarded by exactly the same `StrictEq`/`StrictNeq undefined`
branch used by destructuring defaults (`destructuring.md`) — there is no
separate "default parameter" opcode:

```
LoadParam <dst>, <paramIndex>
StrictEq  <cmp>, <dst>, <undefinedReg>
JmpFalse  SKIP_DEFAULT, <cmp>       ; param WAS passed (dst !== undefined) -> skip evaluating the default
<default expression instructions>   ; only run when the check falls through
Mov       <dst>, <defaultResult>
SKIP_DEFAULT:
```

Because the default expression is **ordinary bytecode inline at the
call-preamble**, not a separate thunk, it (a) genuinely only runs when the
corresponding argument is `undefined` (confirmed by `51`'s
`withSideEffectDefault`, whose side effect — incrementing a counter — only
fires on calls that omit the argument, per the fixture's own assertion),
and (b) can reference **earlier** parameters freely
(`chainedDefaults(a=1, b=a+1, c=a+b)`), because those parameters' `LoadParam`
+ default-check sequences have already executed and stored real values by
the time a later parameter's default expression runs — there is no
forward-reference restriction to represent, evaluation is just strictly
left-to-right through the parameter list, exactly matching source order.

## 3. CFG/IR shape

One two-way branch per defaulted parameter, all at the very start of the
function body, before any user-written statement. Structurally
indistinguishable from an equivalent hand-written
`if (x === undefined) x = expr;` at the top of the function — which is
precisely correct, since that is exactly what a default parameter *means*.

## 4. Matcher

Recognises: immediately following a `LoadParam` (or a chain of them, for
multiple defaulted parameters), a `StrictEq/Neq` against a known-`undefined`
register whose true/false arms are (a) do nothing, keep the loaded param, or
(b) evaluate an expression and overwrite the same register — occurring
before any other statement in the function. Refuses to match a
`StrictEq/Neq undefined` check appearing **after** other statements have
run (that's an ordinary user `if`, not a default parameter — the
positional constraint, "immediately following this parameter's `LoadParam`,
before any other side-effecting instruction," is what distinguishes them).

## 5. Writer

Emits `function f(a, b = expr, ...) {}`, folding the guard back into
parameter-list syntax and dropping the explicit branch.

## 6. Checker

Beyond stage-B default: asserts the default expression, if it references
other parameters, only references ones whose own default-check sequence
comes *earlier* in the recovered parameter list (should be guaranteed by
construction from bytecode order, but the checker asserts it rather than
assuming it, since a violation would indicate the matcher misidentified
parameter boundaries).

## 7. Version differences

Cross-checked at v99 (`51-default-params`, `-O0`): the raw bytecode idiom
(§2) is unchanged — the same `LoadParam` + `StrictEq/Neq undefined` guard —
except that v99 interleaves each defaulted parameter's own `LoadParam`
immediately before its own guard, where v94 hoists every defaulted
parameter's `LoadParam` to the front of the function (before the *first*
guard). Both orders are accepted by the pass (`src/passes/default-params`);
neither changes what the guard means.

**Stage-B AST correction (docs/PUSHBACK.md P-8).** This file's §3/§4
described the structurer's stage-B output as a plain
`if (dst !== undefined) {} else { …default… }`. Measured directly
(`--emit-tree`/`--emit-ast` on `51-default-params` at both versions), the
shape that actually reaches stage B is one **labeled block per defaulted
parameter**, each with a *tail* `break`:

```js
L0: {
  r0 = arguments[k];          // may include a later parameter's load too (v94)
  if (r0 !== U) {
    break L0;                 // param WAS passed — skip the default entirely
  }
  …default body, ending by assigning r0…
  break L0;
}
```

`label-clean`'s own L2 rule (`docs/specs/passes/06-label-clean.md` §4) does
**not** collapse this into an if/else: L2 only credits the tail set of a
`seq`/labeled body from its *last* element, and here the guarding `if` is
not last (the default body and its own trailing `break` follow it) — so
label-clean refuses (`break-not-in-tail`) and the labeled-block shape
survives unchanged into stage B, where `src/passes/default-params/match.ts`
now matches it directly. The bytecode-level picture in §2 is unaffected —
this correction is about the tree/AST shape the *structurer* produces from
that bytecode, one layer up.
