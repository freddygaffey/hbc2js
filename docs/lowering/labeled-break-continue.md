# `label-clean` / labelled break and continue

**Fixture:** `tests/fixtures/constructs/08-labeled-break-continue/source.js`
**Confidence:** ✅ single-version (v94 `-O0`)

## 1. Source

```js
outer:
for (let i = 0; i < 5; i++) {
  for (let j = 0; j < 5; j++) {
    if (i * j > 6) {
      break outer;
    }
    found.push(i + '*' + j + '=' + (i * j));
  }
}

search:
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 4; j++) {
    if (j === i) {
      continue search;
    }
    skipped.push(i + ',' + j);
  }
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`.
`break outer` (inside the doubly-nested loop, `i*j>6`):

```
[@ 113] Greater 17<Reg8>, 16<Reg8>, 7<Reg8>     ; i*j > 6
[@ 117] JmpTrue 116<Addr8>, 17<Reg8>            ; -> offset 233, PAST BOTH LOOPS' back edges
...
[@ 225] JmpTrueLong -139<Addr32>, 15<Reg8>      ; outer loop's own back edge (i < 5)
[@ 231] Jmp 2<Addr8>                            ; outer loop's normal fallthrough exit
[@ 233] TryGetById 14<Reg8>, 3<Reg8>, 2<UInt8>, 8<UInt16>   ; print('break outer trail:', ...) -- code AFTER the outer loop
```

`continue search` (`j === i`):

```
[@ 320] StrictEq 16<Reg8>, 14<Reg8>, 15<Reg8>   ; j === i
[@ 324] JmpTrue 68<Addr8>, 16<Reg8>             ; -> offset 392
...
[@ 387] JmpTrue -75<Addr8>, 15<Reg8>            ; inner loop's own back edge (j < 4)
[@ 390] Jmp 2<Addr8>                            ; inner loop's normal fallthrough exit
[@ 392] LoadFromEnvironment 14<Reg8>, 0<Reg8>, 1<UInt8>   ; outer loop's OWN update: i++  <-- continue's target
[@ 396] ToNumeric 15<Reg8>, 14<Reg8>
[@ 399] Inc 16<Reg8>, 15<Reg8>
[@ 402] StoreToEnvironment 0<Reg8>, 1<UInt8>, 16<Reg8>
[@ 406] LoadFromEnvironment 14<Reg8>, 0<Reg8>, 1<UInt8>
[@ 410] Less 15<Reg8>, 14<Reg8>, 11<Reg8>
[@ 414] JmpTrue -117<Addr8>, 15<Reg8>           ; outer loop's back edge
```

## 3. CFG/IR shape

**There is no dedicated opcode, flag, or marker for "this jump is a labelled
break/continue."** `break outer` from inside the inner loop is bytecode-
identical to an *ordinary* `break` — it is simply a conditional (or
unconditional) jump whose target happens to be **outside the immediately
enclosing loop's own exit block**, landing in the grandparent scope's
post-loop code. `continue search` is likewise an ordinary jump whose target
is the **outer** loop's update/back-edge-test block rather than the inner
loop's.

This means: from the CFG alone, "labelled break to loop L" and "labelled
continue to loop L" are structurally indistinguishable from any other
multi-level forward/backward jump — the only way to tell them apart from,
say, an irreducible edge or an early-return-flattening artifact is by
**which loop's designated exit/continue block the jump's target block is**.
Concretely:
- a jump landing exactly at loop `L`'s post-loop join block (the block every
  normal exit and every `break` from `L` itself converges on) is `break L`
  (or `break` with no label, if `L` is the innermost loop);
- a jump landing exactly at loop `L`'s back-edge/update block (the block
  that re-evaluates `L`'s condition and jumps back to `L`'s header) is
  `continue L` (or `continue` with no label, if `L` is the innermost loop).

A label is needed in the *emitted JS* precisely when the target loop is not
the innermost one containing the jump — that's a purely structural
(dominance/nesting) fact the matcher computes, not something read off any
instruction.

## 4. Matcher

Requires `while-cond`/`do-while`/`for-header` to have already turned the
raw block graph into `loop` IR nodes (spec 04), each with a known join block
and back-edge/update block (spec 07 §5's stage-A ordering). Then: for every
forward or backward jump whose target is a loop's join or back-edge block
but the jump's *source* is nested inside one or more **additional** loops
between it and that target loop — emit a labelled `break`/`continue`
targeting the outer loop, and synthesize (or reuse) a label for that loop.
Refuses to match jumps whose target is the *innermost* enclosing loop's own
join/back-edge block (that's just `break`/`continue`, no label — the
`label-clean` pass, spec 07 §6 row 9, is responsible for not emitting
redundant labels here).

## 5. Writer

Emits `outer: for (...) { ... break outer; ... }` / `continue search;`,
attaching the label to the target loop's own `for`/`while`/`do` statement
and rewriting the jump as the labelled `break`/`continue` keyword.

## 6. Checker

Beyond stage-A default: asserts the label attaches to a loop that
**actually dominates** every use of that label (a label used by a jump from
outside the loop it's attached to would be a matcher bug, not a valid
program — labels are lexically scoped in source, so this should be
structurally guaranteed by construction, but the checker asserts it rather
than assuming it).

## 7. Version differences

Not cross-checked against v99 in this pass (v94 `-O0` only). No reason to
expect a difference — labelled break/continue lowering doesn't touch the
opcode table changes that separate the eras (environment ops, generator
opcodes); it is pure control flow, like `if-else-chain`.
