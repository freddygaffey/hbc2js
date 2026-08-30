# Default parameters — `undefined`-check, evaluated per-call

**Fixtures:** `39-destructuring-params`, `51-default-params`
**Confidence:** ✅ single-version (v94, `-O0`)

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

Not cross-checked against v99 in this pass (v94 `-O0` only); shares the
`StrictEq/Neq undefined` idiom with `destructuring.md`, which is likewise
only single-version-confirmed. No divergence expected.
