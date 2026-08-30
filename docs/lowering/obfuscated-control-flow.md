# Obfuscated variants: javascript-obfuscator's control-flow flattening vs. Hermes's own constant folding

**Fixtures inspected:** `04-for-loop-basic/source.obf.js`,
`09-switch-fallthrough/source.obf.js`, `19-var-hoisting/source.obf.js`
**Confidence:** ✅ verified (surprising negative result)

## 1. What the obfuscator actually emits

Per `tests/fixtures/OBFUSCATION.md`, `controlFlowFlatteningThreshold: 1`
("every eligible function gets flattened"). Grepping every fixture's
`source.obf.js` for the classic javascript-obfuscator dispatcher signature
(`while(!![]){switch(...[...++]){case '0': ...continue; ...} break;}`)
finds it in exactly one of the three inspected sources —
`19-var-hoisting`'s `demo()` (the others' obfuscated output either reuses
the source's own `switch` unchanged, e.g. `09`, or shows no dispatcher at
all for short functions, e.g. `04`'s top-level `for` loops, which the
obfuscator apparently does not consider eligible for flattening at module/
global scope with this project's config). Where present:

```js
function demo() {
  var _0x17f6bc = {...}, _0xbff501 = _0x17f6bc['cFUmC']['split']('|'), _0xdeb95b = 0x0;
  while (!![]) {
    switch (_0xbff501[_0xdeb95b++]) {
      case '0': var _0x31bca3; continue;
      case '1': print(...); continue;
      case '2': var _0x31bca3 = 1; continue;
      case '3': if (true) { var _0x31bca3 = 2; print(...); } continue;
      case '4': print(...); continue;
      case '5': print(...); continue;
      case '6': return _0x31bca3;
      case '7': print(...); continue;
    }
    break;
  }
}
```
`_0xbff501` is a literal array of single-digit strings (the shuffled
statement order); `_0xdeb95b` is a plain local counter, incremented once
per dispatch. This is source-level CFG flattening in the textbook sense —
and is, not coincidentally, structurally identical to `docs/DECISIONS.md`
D6's `for(;;) switch(ip)` fallback shape the decompiler itself would emit
for genuinely irreducible control flow.

## 2. What `hermesc` does with it

**`hermesc` — at BOTH default `-O` and `-O0` — completely eliminates the
dispatcher.** Compiling this exact `demo()` (`tools/hermesc/v94/hermesc
-dump-bytecode -pretty-disassemble=false`, both optimization levels) yields
straight-line bytecode with **zero** `Switch`/`JStrictEqual`/`Jmp`-in-a-loop
instructions related to the dispatcher — confirmed by grepping the entire
compiled `demo` function body for `Switch|JStrictEqual` (0 matches) and for
generic `Jmp` (a handful, all attributable to the *source's own*
`if (true) { ... }` block, not the flattening loop). The function compiles
to the same straight-line call sequence a non-obfuscated `demo()` would
produce (modulo the renamed/string-array-encoded identifiers and literals,
which Hermes does resolve away since they're all local, non-escaping,
compile-time-constant array literals with a monotonically-incrementing
constant-foldable index).

**This holds even at `-O0`.** This is not the optimizer's doing (or not
*only* the optimizer's doing) — Hermes's IR generation/constant folding
resolves `_0xbff501[_0xdeb95b++]` at front-end time because every operand
involved (`_0xbff501`, `_0xdeb95b`) is a local, non-captured, never-
reassigned-outside-the-loop value whose entire access pattern is
statically determinable: the array is a literal, the counter starts at a
known constant and increments by exactly 1 on every path through the loop,
so the sequence of `switch` cases taken is fully known at compile time and
the whole `while`/`switch` collapses to its unrolled body in source order.

## 3. Why this matters for the hardened tier (D13)

`docs/specs/07-pass-ladder.md` §9 item 6 expects "abandonment rates... to be
high" on the obfuscated tier and states "a pass with a 0% abandonment rate
on flattened input is probably unsound" — reasoning that assumes the
decompiler's passes will actually **see** flattened control flow in the
`.hbc` it decodes. **This measurement suggests that, at least for
short/simple functions compiled with default or no optimization, they may
not** — `hermesc` has already undone the obfuscator's flattening before the
bytecode is ever written, for exactly the reason CFG-shape flattening is
supposed to be hard to see through: a sufficiently smart optimizer (or, in
this case, apparently even the baseline front end) can prove the dispatch
is deterministic and inline it away. **The hardened tier's actual stress
value for CFG-shape recovery may be much lower than D13's rationale assumes
for the corpus's typically-small fixture functions** — real-world minified/
obfuscated bundle functions are often much larger and may exceed whatever
threshold makes this constant-folding infeasible, but that is not measured
here and should not be assumed either way.

**Recommended follow-up (flagging for the overseer, not resolving here):**
1. Check whether `hermesc` still collapses the dispatcher for a *larger*
   flattened function (many more cases, non-trivial per-case bodies with
   side effects that could plausibly defeat constant folding, e.g. bodies
   that mutate the dispatch array or index itself, which javascript-
   obfuscator's more aggressive settings can produce).
2. If the collapse is genuinely universal for this obfuscator's default
   output shape, D13's hardened tier needs a stressor that survives
   `hermesc`'s own front end — e.g. object-property-indirected dispatch, or
   an index whose value depends on a **not**-compile-time-knowable input
   (a function parameter, a call result) — rather than relying on
   `javascript-obfuscator`'s default `controlFlowFlatteningThreshold: 1`
   output as-is.
3. This also means: **any real npm/RN bundle minified+obfuscated with
   similar tooling before being compiled by Metro's `hermesc` step may
   already have had its flattening undone by the time it reaches this
   project's decompiler** — worth checking against `tests/fixtures/bundles/`
   (C3/C4 per D16) once those exist, since it changes what "hardened" bundle
   input actually looks like in practice.

## 4. Where flattening survives: string-array indirection itself

Although the *dispatcher loop* collapses, the **string-array + rotation +
RC4-decode indirection** (also part of this obfuscator's config,
`stringArray`/`stringArrayRotate`/`stringArrayEncoding: ["rc4"]`) does
**not** collapse the same way for identifiers/literals accessed through a
runtime-computed hash/index derived from a *self-modifying* rotation IIFE
(the `(function(a,b){ while(!![]){ try { ... } catch(e){ a.push(a.shift()) }
} })(_0xbf83, offset)` pattern seen in `02-while-loop.obf.js`) — that
mechanism relies on runtime string comparison against a value computed via
`parseInt`/arithmetic on obfuscated numeric-string literals, which Hermes
does still constant-fold (per `docs/specs/07-pass-ladder.md`'s existing
scope, string-array decoding was not the CFG-shape stressor D13 was aiming
for) but the *shape* of the surrounding self-invoking IIFE with its own
`try`/`catch`-guarded `while(true)` loop is a genuine, un-collapsed control
structure that any CFG-shape testing must still handle correctly — it is
just not the *dispatcher* shape D13 intended to stress.

## 5. Version differences

Checked at v94 only (both `-O` and `-O0`); the finding is about front-end
constant folding, not an optimizer pass specific to one version, so no
version sensitivity is expected, but this was not independently confirmed
at v84/98/99.
