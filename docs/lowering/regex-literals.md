# Regex literals — `CreateRegExp` (catalogue row 29)

Measured 2026-09-05 for `docs/specs/passes/23-arguments-form-literal-forms.md`
(rung `literal-forms`, sub-form L-R). Fixture `45-regex-literals`; there is no
v84 build (named capture groups, see the fixture's `versions.txt`).

## 1. Opcode

`CreateRegExp dst, patternStrId, flagsStrId, tableIdx`. Count in the fixture,
`node src/cli.ts disasm <v>.hbc`:

| v94 | v96 | v98 | v99 |
|---|---|---|---|
| 6 | 6 | 6 | 6 |

Version-uniform: same opcode name, same operand count, same six sites. The
pattern and the flags are **string-table entries holding the source text of
the literal**; `regExpStorage` (the compiled bytecode program for the regex)
is never needed to recover the source form, which is why M4 can already print
a faithful `new RegExp(...)` without decoding it.

## 2. What the emitter prints today

`src/emit/literals.ts` `regExpExpr` — `new RegExp(<pattern>, <flags>)`.
Identical at all four versions (`node src/cli.ts decompile`):

```js
regExp = new RegExp("(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})", "");
regExp2 = new RegExp("\\b\\w+\\b", "g");
regExp3 = new RegExp("^[a-z]+$", "i");
regExp6 = new RegExp(",", "");
```

The flags string is empty for an unflagged literal, never absent.

## 3. Production shape

`tests/fixtures/bundles/rn-template-0.72/index.android.hbc` (v96, default
pipeline): **49** `new RegExp(` sites. The two that fix the escaping rule:

```js
new RegExp("\\/", "g")
new RegExp("^https?:\\/\\/.*?\\/", "")
```

The stored pattern text already carries the `\/` the programmer wrote inside
their `/.../` literal, so re-emitting a literal is a *round trip*, not an
invention. ES `EscapeRegExpPattern` (`RegExp.prototype.source`) is defined to
produce exactly the body of such a literal — including `(?:)` for the empty
pattern — which is what spec 23 §4.2 uses as the escaping rule, with a
`new RegExp(body, flags).source === new RegExp(pattern, flags).source`
round-trip check as the refusal.

## 4. Not read

No `-O` / obfuscated variant was compared (the fixture's `.min`/`.obf` builds
exist), and no version was executed on a VM for this row: the claim here is
about the *emitted source text*, which spec 23's acceptance tests assert
directly at every version.
