# Optional chaining (`?.`, `?.()`, `?.[]`) and nullish coalescing (`??`)

**Fixture:** `48-optional-chaining-nullish`
**Confidence:** ✅ verified (v94, v99, `-O0`)

## 1. Source

```js
print(user?.profile?.name);
print(user?.profile?.contacts?.email ?? 'no-email-on-file');
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:

```
[@ 124] LoadFromEnvironment 32<Reg8>, 9<Reg8>, 0<UInt8>   ; user
[@ 128] Eq 33<Reg8>, 32<Reg8>, 12<Reg8>                    ; user == null   (LOOSE Eq, r12 = LoadConstNull)
[@ 132] JmpTrue 25<Addr8>, 33<Reg8>                        ; nullish -> short-circuit the WHOLE chain to undefined
[@ 135] GetByIdShort 27<Reg8>, 32<Reg8>, 2<UInt8>, 22<UInt8>  ; user.profile
[@ 140] Eq 29<Reg8>, 27<Reg8>, 12<Reg8>                    ; .profile == null
[@ 144] JmpTrue 13<Addr8>, 29<Reg8>                        ; short-circuit
...                                                          ; (continues one Eq/JmpTrue pair per `?.` link)
```

**A single loose `Eq` against `LoadConstNull` is the entire null-or-undefined
check** — Hermes does not emit two separate comparisons (`=== null` and
`=== undefined`); it relies on JS's `==` operator already treating `null`
and `undefined` as mutually loosely-equal and unequal to everything else
(spec's own abstract equality algorithm), so one `Eq` against `null`
correctly implements "is this nullish?" All short-circuiting links in one
`?.` chain jump to the **same** target block, which produces `undefined`
for the whole expression — confirmed by every `JmpTrue` in a chain sharing
one destination address in the disassembly, matching how `for-of.md`'s
iterator-exhaustion checks also converge on one shared exit.

`??` (`a ?? b`) uses the identical `Eq null` check on `a`, but inverted
control (evaluate `b` only when the check is **true**, i.e. nullish) —
structurally the mirror image of `?.`'s "skip the rest when nullish."

`?.()` (optional call) and `?.[]` (optional computed member) guard a
`Call`/`GetByVal` behind the same `Eq null; JmpTrue` pattern as `?.`'s
plain property case — no distinct opcode per chaining variant.

## 3. CFG/IR shape

A chain of two-way branches sharing one merge point, exactly like
`if-else-chain.md`'s shape but with **every** branch's "taken" edge
targeting the *same* block (the whole-expression short-circuit result)
rather than distinct arms. This is the discriminator vs. a genuine
`if`/`else if` chain: in `?.`, every test's true-edge converges; in
`if-else-chain`, each test's true-edge goes to its own distinct body.

## 4. Matcher

Recognises: a chain of blocks, each performing a property/call/index
access on the *previous* block's result and immediately testing that
result with `Eq null`, where every such test's taken-edge targets the
**same** block (the short-circuit result, typically feeding a `Phi`-like
merge with the chain's final successful value — handled by
`expr-rebuild`, spec 07 §6 pass 1, once register merging is visible).
Refuses to match when a test's taken edge goes anywhere other than the
shared chain-exit (that's a different construct — ordinary defensive
`if (x != null)` code, not `?.`).

## 5. Writer

Emits `a?.b?.c` / `a?.b() `/ `a?.[b]`, and `x ?? y` for the inverted-branch
nullish-coalescing shape, folding the whole recognised chain into one
expression.

## 6. Checker

Beyond stage-B default: asserts every short-circuit edge in the chain
really does target the identical block (a chain with divergent short-
circuit targets is not `?.` and must be left as explicit `if`s).

## 7. Version differences

Cross-checked against v99 (`tools/hermesc/v99/hermesc -O0 -dump-bytecode
-pretty-disassemble=false`, 2026-09-02, `docs/specs/passes/18-optional-chain.md`
implementation): the same `Eq`/`JmpTrue`/`GetByIdShort` idiom, byte-for-byte
identical shape —

```
[@ 105] Eq 7<Reg8>, 5<Reg8>, 1<Reg8>
[@ 109] JmpTrue 24<Addr8>, 7<Reg8>
[@ 112] GetByIdShort 7<Reg8>, 5<Reg8>, 1<UInt8>, 22<UInt8>
```

No opcode-table change — `Eq`/`JmpTrue`/`GetByIdShort` are all core-era
opcodes present unchanged through every version this project targets, so
the catalogue row's confidence is `✅ verified` at both v94 and v99.

The **statement-level lowering the `optional-chain` rung's matcher sees**
(spec 18 §2.4) differs by version beyond what this row's own bytecode
evidence covers: v99's optimizer occasionally elides a chain's own base
guard once a *sibling* chain earlier in the same function has already
proven that register non-nullish (observed on `48`'s own `user?.profile?.
contacts?.email` — the second chain over `user` starts directly with
`r9 = r6.profile`, no preceding `r6 == null` guard, because the first
chain over `user` already established it). Spec 18 §4's matcher requires
a base guard to open every run; this optimizer-driven omission is a real,
distinct shape spec 18 does not document, tracked as an open rung-coverage
item (not a catalogue-confidence question) in `docs/BUGS.md`.
