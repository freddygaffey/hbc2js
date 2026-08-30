# `new` expressions — `CreateThis`/`CreateThisForNew` + `Construct` + `SelectObject` triple

**Fixtures:** general — appears in 12/53 v94 fixtures per spec 05 §7.5's
count (`05-for-in-object`, `07-for-of-iterable`, `12`–`16`,
`24-generator-return-throw`, `28-async-await-error`, `29-promise-chaining`,
`47-typeof-instanceof-in`, `50-this-binding`), and in every `class`
instantiation (`32`–`36`, see `classes.md`).
**Confidence:** ✅ verified (v84/v94/v96 vs v98/v99) — this file was written
after `docs/specs/05-emitter.md` §7.5 already measured and specified the
identical idiom (commit `908cc1d`, "Revise M3-M5 specs after adversarial
review", B2); this project's own independent read (from `classes.md`'s
class-instantiation research) agrees with it exactly, and this file adds
the general (non-class) case spec 05 measured on
`13-try-finally-no-catch`'s `new Error(...)`. **No disagreement found.**

## 1. Source

```js
try { print('entering try'); throw new Error('propagated'); }
finally { print('finally always runs'); }
```

## 2. Bytecode

**v84/v94/v96** — `CreateThis` + a separate `.prototype` fetch:

```
[@ 19] TryGetById    2<Reg8>, 0<Reg8>, 2<UInt8>, 9<UInt16>    ; r2 = global.Error
[@ 25] GetByIdShort  0<Reg8>, 2<Reg8>, 3<UInt8>, 13<UInt8>    ; r0 = r2.prototype
[@ 30] CreateThis    1<Reg8>, 0<Reg8>, 2<Reg8>                ; r1 = OrdinaryCreateFromConstructor(r2, r0)
[@ 34] LoadConstString 4<Reg8>, 6<UInt16>                     ; arg
[@ 38] Mov           5<Reg8>, 1<Reg8>                         ; thisArg frame slot <- r1
[@ 41] Construct     0<Reg8>, 2<Reg8>, 2<UInt8>               ; r0 = r2.[[Construct]](this=r1, arg)
[@ 45] SelectObject  0<Reg8>, 1<Reg8>, 0<Reg8>                ; r0 = isObject(r0) ? r0 : r1
```

**v98/v99** — `CreateThisForNew` folds the `.prototype` read into an inline
cache, no separate `GetByIdShort`:

```
[@ 19] TryGetById       2<Reg8>, 0<Reg8>, 1<UInt8>, 9<UInt16>
[@ 25] CreateThisForNew 1<Reg8>, 2<Reg8>, 2<UInt8>
[@ 29] LoadConstString  4<Reg8>, 6<UInt16>
[@ 33] Mov              5<Reg8>, 1<Reg8>
[@ 36] Construct        0<Reg8>, 2<Reg8>, 2<UInt8>
[@ 40] SelectObject     0<Reg8>, 1<Reg8>, 0<Reg8>
```

v96 spot-checked directly against v94 on this project's own fixtures and
confirmed identical to the v84/v94 form (both use `CreateThis`, not
`CreateThisForNew` — consistent with "v96 shares v94's opcode table").

Class instantiation (`classes.md`) is the **same** triple, just with
`CreateThisForNew`'s prototype resolved via `new.target.prototype` rather
than the callee's own `.prototype` — see that file's §2 "Instantiation"
block, which is this exact idiom applied to a `class` constructor.

## 3. CFG/IR shape

`new X(...)` is never a single instruction — there is **no bytecode
expression form for `new` at all**. It is always this exact three- (or
four-, at v≤96) instruction sequence, straight-line (no branches), which
means it is entirely a **stage-B expression-recognition** concern (spec 05
§4/§7's "one instruction, one statement" model does not apply — this is
explicitly called out as an exception in spec 05 §7.5) rather than a
stage-A control-flow idiom. `CreateThis`/`CreateThisForNew` and
`SelectObject` have no standalone JS expression form; only the whole triple
does.

## 4. Matcher

Per spec 05 §7.5 (already fully specified there — restated here for the
catalogue's cross-reference completeness): recognise (1) a
`CreateThis`/`CreateThisForNew` writing `rT` from closure `rC`; (2) a
`Construct rR, rC, argCount` whose `thisArg` frame slot is `rT` (directly or
via an intervening `Mov`); (3) a `SelectObject rD, rT, rR` combining the
same two registers. At v≤96, additionally consume the `GetByIdShort … ,
'prototype'` immediately preceding `CreateThis` when its only use is that
`CreateThis`.

## 5. Writer

Emits `r<D> = new r<C>(<args>)`, consuming all three (or four) instructions.

## 6. Checker

A `CreateThis`/`CreateThisForNew`/`SelectObject` found **outside** a
recognised triple must fail loudly (`E_EMIT_UNSUPPORTED`, per spec 05 §7.5)
rather than being silently skipped — spec 05 already specifies this as a
hard requirement, not a suggestion, because roughly a quarter of the gate
corpus contains at least one `new`.

## 7. Version differences

| | v84/v94/v96 | v98/v99 |
|---|---|---|
| `this` allocation | `CreateThis dst, prototypeReg, closureReg` | `CreateThisForNew dst, closureReg, cacheIdx` (inline-cached `.prototype` lookup, no separate opcode) |
| Extra instruction | `GetByIdShort ..., 'prototype'` immediately before | none — folded into the inline cache |
| `Construct`/`SelectObject` | identical | identical |
