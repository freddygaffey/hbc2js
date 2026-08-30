# Irreducible control flow — where it actually comes from (T9 part 2)

**Fixtures:** none yet — this file is the evidence T9's stress fixtures should
be written against, so they model what shipped bytecode does rather than what
a source shape looks like it should do.
**Confidence:** ✅ measured (rn-template-0.72 bundle, v94) for where
irreducibility occurs; ⛔ not yet reproduced in a hand-written fixture.
**Tool:** `node --experimental-strip-types tools/irreducibility.mjs <file.hbc>`

## 1. The measurement

Ramsey (D7) structures an irreducible region by duplicating nodes, so
`StructuredFunction.duplicatedBlocks` is an objective signal: zero means the CFG
was reducible; non-zero means it was not, and by how much. `dispatchVars`
non-empty means duplication blew the expansion cap and the function fell back to
D6's `for(;;) switch(ip)`.

One trap, hit while writing this: `duplicatedBlocks` is a **collection, not a
count**. Reading it as a number makes `dup > 0` always false and reports every
input as reducible — a silent false negative that produced three wrong results
before a positive control caught it. `tools/irreducibility.mjs` handles both
shapes.

## 2. Positive control — real RN bytecode is irreducible in places

`tests/fixtures/bundles/rn-template-0.72/index.android.hbc` (v94, 4,199
functions, 23,239 blocks): **79 duplicated blocks, 0.34%**, concentrated in
**7 functions**. So irreducibility in shipped React Native code is real but
rare, and it is not spread thin — it is a handful of functions doing something
specific.

| function | duplicated | exception handlers |
|---|---|---|
| `fn#2015 "k"` | 12 | 1 |
| `fn#2277 "ai"` | 6 | 1 |
| `fn#2288 "mi"` | 6 | 1 |
| `fn#626 "di"` | 6 | 1 |
| `fn#637 "wi"` | 6 | 1 |
| `fn#3251 ""` | **37** | **0** |
| `fn#3388 "value"` | 6 | **0** |

**Five of the seven have exception handlers; two do not.** That splits the
target into two families, and both need a fixture:

- **Handler-driven** — a `try`/`finally` whose cleanup path is reachable from
  both the normal and the exceptional edge, inside or around a loop.
  `fn#637 "wi"` is the smallest example (9 blocks, 6 duplicated, one
  `.try T1..T2 -> L4`) and is the one to read first.
- **Loop-driven, no handlers** — `fn#3251` is the largest irreducible region in
  the bundle (37 duplicated blocks) and has no exception handlers at all, so
  its irreducibility comes from control flow alone. This is the "runtime-derived
  state machine / cross-jumped loop" D13a predicted, in minified library code.

## 3. Three hand-written candidates that did **not** work

All three compile at v99 `-O` to fully reducible CFGs (`duplicated=0`). Recorded
so the next attempt does not repeat them:

1. **`for(;;) switch(state)` state machine**, constant state transitions
   (`state = 1; break;`). hermesc keeps the dispatch as a real switch with a
   single loop header; it does not thread the constant assignments into direct
   jumps, which is what would create the second entry.
2. **Two structurally identical loops on either side of an `if`**, hoping for
   tail-merging into one two-entry loop. hermesc does not cross-jump them.
3. **Data-driven `pc` interpreter loop** (`op` read from an array, `continue`
   per case). Single header, reducible.

The lesson is that guessing at source shapes is the wrong method: none of the
obvious "irreducible-looking" sources survives the compiler. The real examples
above are the specification.

## 4. What to write next

Model the two fixtures on §2's two families and measure each with
`tools/irreducibility.mjs` before committing it — a stress fixture that turns
out to be reducible tests nothing. Decompile `fn#637` and `fn#3251` from the
committed bundle first and reconstruct the source shape from the bytecode;
both are in a Metro-minified bundle, so the shapes come from library code
(React internals in `fn#637`'s case, from the `current`/env-slot pattern) rather
than from anything a fixture author would write by hand.
