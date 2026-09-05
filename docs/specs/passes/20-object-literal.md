# 20 — `object-literal` (stage B, catalogue row **28**)

Rebuild `r3 = {}; r3.remove = f; r3.x = 1;` back into `r3 = {remove: f, x: 1}`.

Evidence: `docs/lowering/object-literal.md` (v94 and v99 dumps of
`tests/fixtures/constructs/63-object-literal`). Fixture: `63-object-literal`.
Queue item #7; `docs/BUGS.md`'s 2026-09-01 "E2E tier 1 — buckets
diff:PutNewOwnById/PutById" row.

## 1. Purpose

The single largest readability bucket in the e2e diff triage: 153
rn-template functions, 1114 Service NSW, 248 react-navigation v98 carry a
`NewObject` + own-property-store run that the M4 baseline prints as a bare
`{}` followed by one assignment statement per property. The source was an
object literal; almost every module in a React Native bundle exports one,
and the values are usually **closures** (`literal-with-closure-values`), so
the baseline turns a 6-line `module.exports = { … }` into a 6-statement
paragraph with the register name repeated on every line.

Correctness is not at stake — the rung only changes *how* the same object is
built — so it earns its place by refusing anything it cannot prove
equivalent, and folding a **prefix** of a run when the rest is not
foldable rather than refusing the whole site.

## 2. Baseline shapes (measured, v94 and v99)

Both dumps are in `docs/lowering/object-literal.md`. In one line each:

* **v94**: `NewObject rD` then, with every value already computed into a
  register, one `PutNewOwnByIdShort`/`PutNewOwnById`/`PutOwnByIndex` per
  property, contiguous.
* **v99 (Static Hermes)**: `NewObjectWithBuffer rD, shape, values` — the key
  list is pre-declared in the shape table and the emitter already prints it
  as a populated literal with placeholder values — then
  `PutOwnBySlotIdx`/`DefineOwnByIndex`/`DefineOwnById` per non-constant
  property. Values are computed *between* the stores as often as not.

`src/emit/shapes.ts` resolves a slot index back to its key name, and
`src/emit/lower.ts` lowers every one of these to the same JS AST node —
`assign(member(rD, key), value)` — as `PutById` does. §4 precondition 4 is
the rule that tells them apart again.

## 3. AST the rung owns

None. It writes `k:"object"` nodes (`src/emit/ast.ts`'s `ObjectProp`), which
already exist for `NewObjectWithBuffer`. No framework AST change.

Framework prerequisite (`src/passes/ast.ts`): `originOf(stmt)` and
`opcodeAt(cfg, offset)` — the emitter's `Origin` stamp plus a memoised
offset→opcode index over `ctx.cfg`. Both are framework, not pass, code
(D12a: a pass may not import `src/emit` or `src/cfg`).

## 4. Matcher — preconditions

`match(list, ctx)` scans the statement list for the first index `i` at which
**all** of these hold. Every one of them is a refusal rule; failing one
either skips the definition entirely (1, 2) or ends the run at that
statement so that only the prefix folds (3–7).

1. **Fresh, ordinary object.** `list[i]` is
   `rN = <object literal whose every property value is a literal>` with `rN`
   a register name (`isRegisterName`), and its origin opcode is one of
   `NewObject`, `NewObjectWithBuffer`, `NewObjectWithBufferLong`.
   `NewObjectWithParent`/`NewObjectWithBufferAndParent` are refused: their
   prototype is a runtime value the rebuilt literal would silently drop. A
   property value that is *not* a literal means the list has already been
   rewritten once — this is also the rung's PL-08 fixed point.
2. **Straight-line, contiguous run.** The folded stores are exactly
   `list[i+1] … list[i+n]`, with nothing in between. `match` is called per
   statement list, so an `if`/loop/`try` body is a different list and a
   control-flow boundary can never be crossed. Contiguity is what makes the
   rewrite trivially effect-preserving: the only statement a folded value
   expression moves across is the definition itself, and creating an object
   is unobservable, so no two effects change order. The first non-store
   statement ends the run.
3. **A store into that register, with a statically known key.** `list[j]` is
   `rN.key = v` (non-computed, `key` a safe identifier) or `rN[k] = v` with
   `k` a canonical integer index or a quoted string literal. Anything else
   (a computed key that is an expression, a `rN[rM] = v`) ends the run.
4. **The store opcode is an own-property define.** Read from the statement's
   origin: `PutNewOwnById`/`…Long`/`…Short`, `DefineOwnById`/`…Long`,
   `PutOwnByIndex`/`…L`, `DefineOwnByIndex`/`…L`,
   `PutOwnBySlotIdx`/`…Long`. **`PutById`/`PutByIdLoose`/`PutByIdStrict`/
   `TryPutById`/`PutByVal…` end the run**: they are a full `[[Set]]`, which
   walks the prototype chain, so `o = {}; o.a = v` is *not* `o = {a: v}`
   when `Object.prototype` carries an accessor or a non-writable `a`. See
   `docs/lowering/object-literal.md`'s opcode table and DECISIONS D24.
   A statement with no origin (one a previous rung synthesised) also ends
   the run — the rung never guesses.
5. **The key is not `__proto__`.** In a non-computed literal key position
   `__proto__: v` sets the prototype instead of defining a property.
   Refused in both spellings (`__proto__` and `["__proto__"]`) so that one
   rule covers both.
6. **The value does not observe the half-built object.** `identUses` of
   `rN` over the store's value expression must be zero reads and zero
   writes: `r3.b = r3.a + 1` reads the partially-built object and is not a
   literal; `r3.a = f(r3)` escapes it. (The half-built object cannot be
   observed any *other* way: `rN` is a Hermes register, nothing else can
   name it, and until a store leaks it the object is unreachable.)
7. **Accessors and non-enumerable defines are not `assign` nodes at all.**
   The emitter renders `PutOwnGetterSetterByVal` and `PutNewOwnNEById` as
   `Object.defineProperty(rN, …)` calls, which fail precondition 3 *and*
   read `rN`, so a getter in the middle of a literal ends the run there and
   the properties before it still fold. Fixture case E is exactly this.

At least one store must fold (`n >= 1`), otherwise `match` moves on — which
is also what makes the rung idempotent.

**Duplicate keys.** If a store's key is already in the accumulated property
list (the v99 `NewObjectWithBuffer` placeholder case) its value is replaced
**in place**, keeping the original position. That is precisely what
`{k: <lit>, …, k: v}` means and what re-defining an existing own data
property does: the property keeps its insertion position and takes the new
value. Nothing observable is lost by not evaluating the placeholder, because
precondition 1 has already established it is a literal.

## 5. Writer

`list[0…i-1]` ++ `[{...list[i], expr: rN = {props}}]` ++ `list[i+1+n…]`.

The definition statement is spread rather than rebuilt so the `NewObject`
instruction's `origin` stamp survives onto the rebuilt literal — it really
is the statement that instruction produced. Integer keys are written
non-computed (`{0: v}`, not `{[0]: v}`); a key that needed quoting stays
computed (`{["a b"]: v}`), matching `src/emit/literals.ts`'s own rendering
of a buffer literal.

## 6. Checker

Recompute-and-diff, the `optional-chain`/`spread-rest` pattern: `check`
re-runs the real matcher on `before` and never looks at the driver's
captured match data. It then asserts

1. `after.length === before.length - storeCount`;
2. every statement before the definition, and every statement after the run,
   is **reference-identical** to its `before` counterpart (so the rung
   cannot have touched anything outside the run);
3. `after[defIndex]` is `rN = <object>` for the recomputed `rN`;
4. the written property list is, element for element, the recomputed one:
   same length, same key, same `computed` flag, same order, and each value
   structurally equal to the store's own value expression — which is how a
   dropped, duplicated or reordered property is caught;
5. no written property value mentions `rN` anywhere (precondition 6
   restated on the *output*, with a deliberately over-eager syntactic search
   that also looks inside nested closures);
6. `parses(after)`.

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `after: ["expr-rebuild", "global-access", "call-shape"]`,
`before: ["jsx-recover", "var-naming"]`; registered between
`optional-chain` and `jsx-recover`, i.e. last but one in D23's
structure-recovery block.

* *After `expr-rebuild`*: a store's value is a bare register until
  `expr-rebuild` has inlined the expression that produced it. Before it,
  every literal would come out as `{x: r3, y: r2}` — no worse, but no better
  than the baseline either.
* *After `global-access` and `call-shape`*: a method value that is still a
  `Reflect.apply` survivor or a `globalThis.x` chain is not worth hoisting
  into a literal, and both rungs rewrite exactly the expressions this rung
  then freezes into property positions.
* *Before `jsx-recover`*: `jsx-recover` keys on the **props object** of an
  element-creation call. A props object built by `NewObject` + stores is not
  an `object` node until this rung has made it one, so running after
  `jsx-recover` would leave every such element unrecovered.
* *Before `var-naming`* (and therefore before `fn-naming`/`reg-split`): D23
  — this is a structure-recovery rung, it deletes statements and it reads
  the bytecode origin of the statements it deletes, so it must run while
  every register still carries its original bytecode identity.

**Resolved, under a condition** (docs/BUGS.md `object-literal-putbyid`,
`object-literal-interleaved`, `object-literal-computed-key`):

* **`PutById`/`PutByIdLoose`/`PutByIdStrict`/`TryPutById` on a fresh object**
  now folds like an own-define for a plain data key, **unless** the key is
  `__proto__` (still a `[[Set]]` that hits `Object.prototype`'s own
  accessor, never a define) **or** anything in the run so far — including
  the store's own value — has an `effectSequence` (a call, `new`, a member
  read, …): `OrdinarySet` on a fresh object with an unmodified prototype
  chain falls through to `CreateDataProperty`, exactly `[[DefineOwnProperty]]`'s
  outcome, but only while nothing has had a chance to have put an accessor
  or non-writable data property on `Object.prototype` first. See
  `src/passes/object-literal/match.ts`'s `PUT_BY_ID` doc comment for the
  full argument. Scope: this is a *local* proof over the run being folded,
  not a whole-program one — code that mutates `Object.prototype` earlier in
  the same function, before the object is even created, is out of scope the
  same way it always has been.
* **An interleaved statement inside the run** (v98/v99 `NewObjectWithBuffer`
  computing a value *between* two stores, `63-object-literal` fn `table`) no
  longer ends the run outright: a **pure register def** (`rX = <expr>` with
  no call/member access — `isPure`) commutes above the whole run when
  `canHoist`'s three-part check proves it safe (no earlier fold already read
  `rX`; nothing `rX`'s value reads was written by the run so far; `rX` is
  not the object's own register) — see `match.ts`'s `canHoist` doc comment
  for the exact rule and its unit tests for both directions. **Residual**: a
  register *reused* for a self-referential redefinition (`r2 = r3 + r2`,
  `table`'s `len` property at v98/v99) correctly still refuses — hoisting it
  would change what an earlier fold in the same run read from that same
  register — so `table` folds 3 of its 4 properties into the literal at
  v98/v99 (`len` stays a trailing store) and 2 of 4 at v84/v96 (a different,
  unrelated register-reuse shape for the `10` key); only v94's register
  allocation happens to give every value its own register, folding all 4.
  This is a real, permanent limit of the sound local commutation rule, not
  an unimplemented case — folding it would require reasoning about which
  *generation* of a reused register a later statement reads, which this
  rung does not attempt.

* **`PutOwnByVal`/`DefineOwnByVal` (a computed key)** (docs/BUGS.md
  `object-literal-computed-key`) now folds too — unlike `PutNewOwnById`/
  `PutById`, this opcode is only ever emitted for an object-literal
  *syntax* property (`{[k]: v, ...}`); a later, separate `o[k] = v`
  assignment statement compiles to a full-`[[Set]]` `PutByVal` this rung
  does not touch, so there is no `object-literal-putbyid`-style
  prototype-chain question here at all. `storeOf` already handles the case
  where `expr-rebuild` inlined the key down to a literal (a compile-time
  constant, treated exactly like any other own-define). For a key that is
  still a genuinely dynamic expression — a register, a free-variable read,
  a `member` chain ("member-of-const"), or a richer expression (a call, …)
  that `expr-rebuild` already proved safe to inline at exactly that
  position via its own R1a/R1b adjacency rule (`docs/specs/passes/
  02-expr-rebuild.md`) — a new `computedStoreOf` recognises the store and
  folds key and value together once each passes the same "does not read or
  write the object's own register" check every other store's value
  already gets (`match.ts`'s `computedStoreOf` doc comment); the key is
  rendered into `ObjectProp.key`'s string field at ASSIGNMENT precedence by
  a new `renderComputedKey` (`src/passes/ast.ts`, the same D12a
  `print.ts`-re-export gap `printProgram` already uses — `ClassMember.key`'s
  `classMemberKey` renderer is the precedent, same bound). **Duplicate-key
  aliasing**: a computed key's runtime value can coincide with an
  already-declared literal key, and this rung cannot prove it does not. A
  *later* plain-key store's own fold (`props[at] = …`) keeps that entry's
  *printed position* — correct when the two entries are provably the same
  literal spelling, but if a **computed** key sits between them and might
  alias that same runtime key, printing the later plain store's replace
  ahead of the computed entry (in the run's *textual* position, though it
  ran chronologically *after* it) would let the wrong write win: `{a:
  <placeholder>}` then `o[k]=5` then `o.a=10`, if `k==="a"`, must end at
  `a: 10` (the last chronological write) — folding all three naively as
  `{a: 10, [k]: 5}` evaluates `k` *after* `a`'s replace and ends at `a: 5`
  instead. So a computed key may fold only while it is the run's last
  fold, or every fold after it is also computed — a fresh `props.push` for
  a *new* key, computed or not, never has this problem (it always
  preserves program order relative to every earlier entry; only the
  *replace-in-place* shortcut can jump a later chronological write ahead
  of an unproven-non-aliasing computed one). `match.ts`'s `sawComputedKey`
  flag enforces exactly this: once true, no further literal-key fold is
  attempted in the run — a prefix-fold, same as every other refusal here.

**Refusals left open** (each a prefix-fold, never a wrong rewrite):

| Shape | Why refused | Ledger |
|---|---|---|
| `PutById`-family key `__proto__`, or a run that has already had an effect | still a full `[[Set]]` on `Object.prototype`, or the prototype chain may have changed since the object was created | `docs/BUGS.md` `object-literal-putbyid` |
| an interleaved statement that is not a *pure register def*, or one `canHoist` refuses (reads the object being built, or redefines a register an earlier fold already read) | commuting it above the run is not proven safe | `docs/BUGS.md` `object-literal-interleaved` |
| a computed-key store whose key or value reads/writes the object's own register | precondition 6, same as every other store | `docs/BUGS.md` `object-literal-computed-key` |
| a plain-key store that follows an already-folded computed-key store in the same run | the computed key might alias it at runtime; folding both risks the wrong write winning (see above) | same row |
| accessor properties (`get`/`set`) | no literal AST for them; run ends there, prefix folds | same row |

**Fixtures.** `63-object-literal`: A plain data literal, B literal with
closure values, C integer keys, D negative (intervening read), E negative
(accessor mid-literal), F negative (the object escapes mid-run).
`77-object-literal-computed`: G computed key from a parameter, H computed
key from a call result, I a plain key folding together with a following
computed one, J negative (a plain key after a computed one — the aliasing
hazard). All five HBC versions.

**Metrics.** rn-template and Service NSW `diff:PutNewOwnById/PutById`
bucket counts, before/after — reported in the landing report and
`docs/AGENT-LOG.md`.
