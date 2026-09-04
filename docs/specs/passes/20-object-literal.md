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

**Refusals left open** (each a prefix-fold, never a wrong rewrite):

| Shape | Why refused | Ledger |
|---|---|---|
| `PutById` run on a fresh `{}` (`o = {}; o.a = 1;` in the source) | full `[[Set]]`, prototype-chain observable | `docs/BUGS.md` `object-literal-putbyid` |
| v99 runs with a value computed **between** two stores (`63-object-literal` fn `table` at v99) | folding would move a value expression across an interleaved statement | `docs/BUGS.md` `object-literal-interleaved` |
| `PutOwnByVal`/`DefineOwnByVal` (a computed key expression) | the key expression would have to move with the value | `docs/BUGS.md` `object-literal-computed-key` |
| accessor properties (`get`/`set`) | no literal AST for them; run ends there, prefix folds | same row |

**Fixtures.** `63-object-literal`: A plain data literal, B literal with
closure values, C integer keys, D negative (intervening read), E negative
(accessor mid-literal), F negative (the object escapes mid-run). All five
HBC versions.

**Metrics.** rn-template and Service NSW `diff:PutNewOwnById/PutById`
bucket counts, before/after — reported in the landing report and
`docs/AGENT-LOG.md`.
