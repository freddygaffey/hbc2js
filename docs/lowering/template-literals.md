# Template literals — `HermesInternal.concat` (untagged) and `getTemplateObject` (tagged)

**Fixtures:** `43-template-literals`, `44-tagged-templates`
**Confidence:** ✅ verified (v94 and v99, at `-O` **and** `-O0`)
**Pass:** `template-literal` (stage B, `docs/specs/passes/14-template-literal.md`)

> **Correction (2026-09-01).** An earlier revision of this file said a
> template literal lowers to "the same `LoadConstString`/`Add`/`AddS` chain a
> hand-written `'a' + b + 'c'` would produce" and that a recovery pass could
> only be a style heuristic. That was wrong at every optimisation level, not
> just at `-O` (`docs/PUSHBACK.md` P-2 claimed the split was `-O` vs `-O0`;
> §2 below shows `-O0` emits `concat` too). The only `Add` in fixture 43's
> dump is `computeExpr`'s genuine `a + b`.

## 1. Source

```js
const name = 'World';
const simple = `Hello, ${name}!`;              // untagged, 1 substitution
const multiline = `Line one
Line two with ${items.length} items
Line three`;
print(inspect`a\n${x}b\tc${x + 1}d`);          // tagged (44)
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O -dump-bytecode` (identical shape at v99; the
`-O0` dump differs only in register allocation and spills):

```
    TryGetById        r2, r0, 1, "HermesInternal"
    GetByIdShort      r6, r2, 2, "concat"
    LoadConstString   r5, "Hello, "
    LoadConstString   r3, "World"
    LoadConstString   r2, "!"
    Call3             r5, r6, r5, r3, r2        ; concat.call("Hello, ", "World", "!")
```

A template literal with `n ≥ 1` substitutions becomes **one call to
`HermesInternal.concat`** whose `this` is the first cooked chunk and whose
arguments alternate `substitution, chunk, substitution, …`; a trailing empty
chunk is elided (`` `${i}:${it}` `` → `this = ""`, args `i, ":", it`). Counts of
`"concat"` property loads per dump of fixture 43 (5 templates + 2 nested):

| | v94 `-O` | v94 `-O0` | v99 `-O` | v99 `-O0` |
|---|---|---|---|---|
| `"concat"` loads | 7 | 7 | 7 | 7 |
| `Add`/`AddN` | 1 (`a + b`) | 2 (`a + b`, `a * b` spill) | 1 | 1 |

Control fixtures at `-O`, same compilers: `01-if-else-chain`
(`'check(' + n + ')'`) and `51-default-params` (`'Hello, ' + name + '!'`) —
**0** `concat` loads; their concatenation is `Add`. So ordinary `+` never
produces `concat`, and a template with a substitution always does. The
discriminator is semantic, not stylistic: `concat` applies **ToString** to
every piece, `+` applies **ToPrimitive** (hint default) — `{valueOf(){return
1}}` renders `"1"` under `+` and `"[object Object]"` under `concat` — so the
compiler cannot use one for the other.

A template with **no** substitution is a plain `LoadConstString`; nothing
distinguishes it from a string literal and nothing should.

**Tagged templates** (`44`) additionally emit
`CallBuiltin "HermesBuiltin.getTemplateObject"` with arguments
`(siteId, dup, …strings)` — `dup:true` → the strings are both raw and cooked;
`dup:false` → the first half are raw, the second half cooked — followed by an
ordinary call of the tag with the returned object as its first argument
(v94 and v99: 3 sites, ids 0/1/2). The builtin caches one frozen object per
site id (see the builtins table in `docs/LOWERING-CATALOGUE.md`).

## 3. CFG/IR shape

Straight-line. After `expr-rebuild` + `global-access` the emitter's JS is:

```js
r5 = Reflect.apply(__hbc_HermesInternal.concat, "Hello, ", ["World", "!"]);
r5 = Reflect.apply(rK, "", [r9, " + ", r8, r2, r16]);      // rK = __hbc_HermesInternal.concat spilled
r6 = __hbc_b_getTemplateObject(0, false, "a\\n", "b\\tc", r4, "a\n", "b\tc", r4);
r1 = r5(r6, 42, 43);
```

Chunk registers (`r2 = " = "`) and the spilled callee are defined by the
nearest preceding assignment in the same statement list; the frame reuses
those registers for unrelated values before and after.

## 4. Matcher

`src/passes/template-literal/match.ts` (spec 14 §4). T1: a
`Reflect.apply(F, C0, [literal array])` whose `F` is the concat member, or a
register whose nearest preceding definition in the list is that member; every
even element of `[C0, …args]` must resolve to a string literal, at least one
substitution, no `seq`. T2: `rT = __hbc_b_getTemplateObject(id, dup, …S)`
with `id`/`dup`/`S` all resolvable, followed in the same list by the only
read of `rT` as the first argument of a call; `raw.length === subs + 1`;
`cook(raw[i]) === cooked[i]`; the site id unique in the frame. Refusal
reasons are the thirteen §7 strings.

## 5. Writer

T1 → `{k:"template", quasis: chunks.map(escapeForTemplate), exprs: subs}`,
substitutions by reference; T2 → `{k:"tagged", tag, quasi:{quasis: raw}}` and
statement `A` deleted. Printed:

```js
r5 = `Hello, ${"World"}!`;
r5 = `Line one
Line two with ${r4.length} items
Line three`;
r1 = r5`a\n${42}b\tc${43}d`;
```

## 6. Checker

Structural (`check.ts`): sites re-derived from `before` alone, `after`
byte-identical to the pure builder's output, substitutions reference-equal,
every quasi re-cooked against its chunk, printed node re-parsed. Exact under
D14: `concat` and a template both ToString each substitution left to right;
`getTemplateObject`'s per-site cached object and the engine's per-site
template object have the same identity semantics.

## 7. Version differences

None observed between v84…v99 for either form (all five versions of both
fixtures go red→green through the same matcher; `tests/gate/passes/
template-literal.test.ts`). `AddS` is unrelated (string-specialised `+`).
