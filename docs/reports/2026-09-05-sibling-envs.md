# Sibling environments: what actually causes the residual `diff:LoadFromEnvironment(imm)` bucket, and why the block-scope fix cannot work

Agent: `agent/sibling-env-2`, 2026-09-05. Fixture `tests/fixtures/constructs/75-sibling-envs`,
test `tests/gate/emit/sibling-env-slots.test.ts` (RED). See `docs/PUSHBACK.md` P-41.

## 1. The construct

`hermesc -O` **inlines an IIFE into its caller but keeps the callee's own
environment**. A caller that inlines several of them therefore ends up with
several environments side by side, all children of the same parent scope:

    function make(items) {
      var out = {};
      (function () { var a = items[0], b = items[1]; out.ab = function () { return a + b; }; })();
      (function () { var c = items[2];              out.c  = function () { return c * 10; }; })();
      (function () { var d = items[0], e = items[1], f = items[2];
                     out.def = function () { return d + e + f; }; })();
      return out;
    }

compiles (v98) to one function with three `CreateFunctionEnvironment` of 2, 1
and 3 slots, and three reader closures loading slots `(0,1)`, `(0)` and
`(0,1,2)`. That is the shape of react-navigation-example module 681 / fn#683:
one `CreateFunctionEnvironment r4, 11` plus twelve sibling
`CreateEnvironment`/`CreateFunctionEnvironment` in the same function.

Our emitter declares every environment a function owns as one flat
`let _e<env>_<slot>` list in the function's top scope
(`src/emit/function.ts` `ownedEnvSlots`), so recompiling the decompiled source
gives hermesc a single scope: it allocates a **single**
`CreateFunctionEnvironment(6)` and the readers become `(0,1)`, `(2)`,
`(3,4,5)`. That is exactly the `diff:CreateFunctionEnvironment(imm)` and
`diff:LoadFromEnvironment(imm)` verdicts on the corpus.

Versions: v98 and v99 reproduce. v84/v94/v96 do not inline these IIFEs at all
(the callee stays its own function), so there are no siblings to flatten.

## 2. Why the two earlier synthetic repros failed

Both earlier attempts (`{ let x; function get(){return x} }` blocks, and a
three-export lazy-require barrel) used **block scopes**, and hermesc -O merges
sibling block scopes into the enclosing function environment. Probed directly
on hermesc v98: three sibling `{ let a; fns.push(function(){return a}) }`
blocks in one function compile to ONE `CreateFunctionEnvironment(3)`, in the
original as well as in the recompile — so nothing ever diverged. The trigger
is inlining, not block scoping.

## 3. Why the briefed fix (emit each sibling environment as a block scope) cannot work

Same reason. Taking the decompiled output of fixture 75 and hand-rewriting it
so that each environment's slots and its reader closure sit inside their own
`{ let _eN_0, _eN_1; function reader() {...} ... }` block, then recompiling
with hermesc v98, still gives `CreateFunctionEnvironment(6)` with readers on
slots `(0,1)`, `(2)`, `(3,4,5)` — byte-identical to the flat form. Block
scopes are free at this level; hermesc's scope allocator flattens them.

Hand-rewriting the **same** ranges as `(function () { ... })();` instead
reproduces the original exactly: `CreateFunctionEnvironment(2) / (1) / (3)`
and readers on `(0,1)` / `(0)` / `(0,1,2)`.

So the only source form that round-trips a sibling environment is the IIFE it
came from.

## 4. What an IIFE-emitting fix would have to do, and why it was not landed

It is a real option — arguably the *more* faithful decompilation, since the
original source really did contain an IIFE — but it is a design decision, not
an implementation detail, and it is bigger than the briefed change:

1. **Readability.** The output gains `(function () { ... })();` wrappers in the
   middle of ordinary function bodies. The project's order is correct first,
   readable second; round-trip identity is a metric, not correctness. Trading
   readability for a metric needs Fred or the orchestrator to say yes.
2. **Safety guards.** An IIFE is only transparent if the wrapped statement
   range contains no `return`, `break`, `continue`, `this`, `arguments`, no
   `yield`/`await`, and declares nothing used after the range.
3. **Guard 2 already refuses on the minimal case.** In fixture 75's own
   decompiled output the scratch register declaration `let r0 = undefined;`
   falls inside environment 1's statement range and is read again inside
   environment 2's range. A contiguous-range IIFE would refuse there, so the
   fix does not work at all unless such declarations are first hoisted out of
   the range — extra machinery with its own correctness argument.
4. **Placement.** The reader closures are emitted as hoisted `function`
   declarations at the top of the body, away from the statements that fill
   their environment, so the transform must move declarations as well as wrap
   a range.

Recommendation: treat this as a scoped follow-up with an explicit decision on
(1), most plausibly as an **opt-in** emit mode used by the round-trip harness
rather than a default, so readable output is not paid for a corpus metric.
Until then the BUGS row stays open with the repro now pinned by fixture 75.
