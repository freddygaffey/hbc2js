# Irreducible control flow — where it actually comes from (T9 parts 2 and 3)

**Fixtures:** `tests/fixtures/constructs/100-irreducible-try-retry` (handler-driven
family) and `tests/fixtures/constructs/101-irreducible-loop-window` (loop-driven
family) — both measured genuinely irreducible (`duplicated>0`) at all five
hermesc versions (84/94/96/98/99) and PASS the gate 5/5.
**Confidence:** ✅ measured (rn-template-0.72 bundle, v94) for where
irreducibility occurs; ✅ reproduced in both hand-written fixtures.
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

## 4. What actually reproduces it (T9 part 3)

Both fixtures were found by measurement, not by pattern-matching the disassembly
by eye — the eyeball reading of `fn#637`'s block graph below turned out to
predict *reducible*, and the tool proved that wrong for the wrong reason (the
real trigger is narrower than it looks). Treat this section as "what to try",
not "why it must work" — every claim here was checked with the tool, not
derived from first principles alone.

### 4.1 Handler-driven: `100-irreducible-try-retry`

`fn#637 "wi"`'s exception-handler table entry is `{start: 0x4f, end: 0x58,
target: 0xa1}` (dumped straight from `parseHbc`, not eyeballed off the
disassembly) — the guarded range is *only* two instructions: the one call at
label `L2` (`0x4f`), not the whole function. The catch handler at `0xa1` runs
its own recovery call, then jumps back to `0x4f` — i.e. it **retries the
guarded call**, not "falls through to the code after the try/catch" the way a
plain `try { } catch (e) { }` would. `L2` also has two normal predecessors
(both funnelled through one earlier `if`, matching `fn#637`'s `L1`).

By classic dominance-based reducibility (the T1/T2 collapse), this is still
single-entry — `L2` is the sole loop header, `L4`'s only predecessor is `L2`'s
guarded call, everything funnels through one `if` before reaching `L2` at all.
Read that way, it predicts **reducible**, and the very first thing tried along
those lines (a `while(true) { try { call(); } catch(e) { recover(e); continue;
} break; }` with no surrounding `if`) measured `duplicated=0` — confirming a
retry loop *by itself* is not enough, matching finding 4.2 below and the three
D13a-part-2 failures. What tipped it into `duplicated>0` was adding back
`fn#637`'s `if`/`if` **before** the loop that feeds two different paths into
the loop's single guarded statement (`100-irreducible-try-retry/source.js`
mirrors this: `getState1()`/`getState3()` checks, then `clearPending()` +
`prepareRetry()` on the miss path, both converging into the
`while(true){ try { … } catch(e) { …; continue; } break; }` retry). Measured:
**12 blocks, 8 duplicated**, one handler — close to `fn#637`'s own 9/6/1.
So the eyeball dominance argument was incomplete: Ramsey's structurer is
pickier than classic T1/T2 reducibility once a try/catch region has to be
expressed as a *structured* construct, and pre-loop branching that fn#637
happens to have was, empirically, the ingredient that mattered — not the
retry-via-catch shape itself.

### 4.2 Loop-driven, no handlers: `101-irreducible-loop-window`

`fn#3251` (no name; React Native's `VirtualizedList` window-expansion math) is
a `while`-shaped loop whose continue condition is a short-circuited **OR of two
independently side-effecting checks** — one advances a `first`/lo pointer, the
other a `last`/hi pointer, and each disjunct compiles to its own back-edge into
the loop header rather than being folded into one shared continue-test block.
Reproduced directly (first candidate tried, no iteration needed) with
`while (checkLo(lo, weight) || checkHi(hi, n, weight)) { if (checkLo(...)) lo--;
if (checkHi(...)) hi++; }`, where `checkLo`/`checkHi` are ordinary function
calls (calls, not inline comparisons, so hermesc can't CSE the two checks into
one). Measured: **9 blocks, 6 duplicated, 0 handlers** — same shape as
`fn#3251` (no handlers, duplication from control flow alone), smaller in
absolute count than `fn#3251`'s 37 because the real function's two-pointer
scan has more internal branching per iteration, not because the underlying
trigger differs.

### 4.3 What still doesn't work

Confirmed (not re-tried, but consistent with why a retry loop alone measured
`duplicated=0` in 4.1): a loop or try/catch that is single-entry with no
preceding branch feeding it from more than one direction stays reducible,
matching the three D13a-part-2 failures (`for(;;) switch` state machine, twin
loops beside an `if`, data-driven `pc` interpreter) — all single-header, all
reducible. The common thread across every reducible attempt and both working
fixtures: reducibility breaks only once a genuine loop or handler-retry region
is entered, or fed, from **more than one direction that isn't itself funnelled
through a single dominating block** — a plain single-entry loop, however
complicated its body, is not enough on its own.
