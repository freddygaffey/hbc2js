# `typeof` comparisons — `TypeOfIs` / `JmpTypeOfIs` masks (catalogue row 30)

Measured 2026-09-05 for `docs/specs/passes/23-arguments-form-literal-forms.md`
(rung `literal-forms`, sub-form L-T). Fixture `55-typeof-is-masks`; the
negative side is `47-typeof-instanceof-in`.

## 1. Where the opcode exists

`node src/cli.ts disasm tests/fixtures/constructs/55-typeof-is-masks/<v>.hbc`:

| Version | `TypeOf` | `TypeOfIs` | `JmpTypeOfIs` |
|---|---|---|---|
| 94 | 5 | 0 | 0 |
| 96 | 5 | 0 | 0 |
| 98 | 0 | 3 | 9 |
| 99 | 0 | 3 | 9 |

v98 and v99 have identical operands, instruction for instruction. Below 98 the
compiler emits `TypeOf` plus an ordinary comparison, which is the *ground truth
for the source shape*: at v94/v96 the decompiler already prints
`typeof a1 !== "string"`.

## 2. The mask

`TypeOfIsTypes`, a bitset from the MIT-licensed Hermes source
`include/hermes/FrontEndDefs/Typeof.h`, vendored per pin and generated into
`src/tables/generated/typeofis-<pin>.ts`. All three pins that have the header
(`hbc98-late`, `hbc99-feb2026`, `hbc99-mar2026`) agree:

| Bit | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| Member | Undefined | Object | String | Symbol | Boolean | Number | Bigint | Function | Null |
| Value | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |

Nine members, exhaustive over JS values (`typeof`'s eight results with
`object` split into `Object` and `Null`), so the full mask is 511 and there is
no negate flag: `!==` compiles to the complement. `Object` alone does **not**
match `null`; `typeof x === "object"` is therefore the *pair* 2|256 = 258.

Masks present in the fixture at v98 and v99: 1, 4, 8, 16, 32, 64, 128 (single
categories), 258 (Object|Null), 383 (= 511-128, "not function"), 503
(= 511-8, "not symbol"), 507 (= 511-4, "not string").

## 3. What the emitter prints today

`src/emit/typeofis.ts` decodes every mask (review M4-H2) but prints the bitset
shape: a disjunction when at most half the bits are set, otherwise the
negation of the complement's disjunction. Same source, two versions:

| Source | v94 / v96 | v98 / v99 |
|---|---|---|
| `typeof x !== 'string'` | `typeof a1 !== "string"` | `!(typeof a1 === "string")` |
| `typeof x === 'object'` | `typeof a1 === "object"` | `typeof r1 === "object" && r1 !== null \|\| r1 === null` |
| `typeof x !== 'function'` | `typeof a1 !== "function"` | `!(typeof a1 === "function")` |

Whole-module counts, identical with `--passes=none` and with the default
pipeline (so this is pure emitter output): v98/v99 have 3 `!(typeof ` and 2
Object|Null disjunctions; v94/v96 have none of either.

## 4. Negative side

`47-typeof-instanceof-in` compiles its `typeof` uses to plain `TypeOf` at
every version (`typeof r6.neverDeclared`, `typeof arr3`, `typeof obj2`), and
`Inc`/`Dec` lower to a deliberate `typeof r2 === "bigint" ? … : …` guard
(`src/emit/lower.ts`, `ToNumeric` semantics). Neither is a mask expansion and
neither may be rewritten by a readability rung.
