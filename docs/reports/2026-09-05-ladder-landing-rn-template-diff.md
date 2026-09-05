# rn-template-0.72 `decompileTree` diff: main (bb46cf7) -> agent/spec23-impl merged (specs 21+22+23)

Command: `decompileTree(index.android.hbc, { passes: {}, analysis: { strictEnv: false }, verify: false, resolveV98Ambiguity: true })`.
The full unified diff (2809 lines, 686 added / 686 removed lines) was reviewed
at landing time; it is reproducible from the two commits with the command above.

- old sha256 `fa54d8f22ba3ccf07ab00dc07d3374a1443d45ae52d7f3027e321ce5b758d7d8` (reproduced exactly on bb46cf7)
- new sha256 `6c2f2dbe2bbae0aeaa33514ba59153930da48bcdc870bfd1006d36c65d074de1` (pinned in `tests/gate/passes/pipeline-speed.test.ts`)

`decompileTree` prints the stage-A structured tree only, so this diff shows the
three stage-A rungs that landed on this branch (`for-in`, `for-of`, `try-shape`).
The stage-B rungs (`arguments-form`, `literal-forms`, `try-clean`) and main's
`yield-recovery`/`async-recovery` cannot appear here at all.

## Per-rung provenance counts (whole bundle, `passes=` tags)

| rung | before | after | delta |
|---|---|---|---|
| if-chain | 10177 | 10139 | -38 |
| label-clean | 609 | 609 | 0 |
| loop-cond | 254 | 254 | 0 |
| for-header | 2 | 2 | 0 |
| try-shape | 0 | 163 | +163 |
| for-of | 0 | 26 | +26 |
| for-in | 0 | 12 | +12 |

The -38 if-chain sites are exactly the 26 `for-of` + 12 `for-in` sites: each
loop's `if`-shaped iterator test is now owned by the loop rung instead. No rung
claims a site another rung already claimed; `loop-cond`/`for-header`/
`label-clean` are untouched.

## Shape of the changes

- 159 function-header lines changed (provenance list only).
- ~1052 body lines changed, all in the same 159 functions. The only structural
  edit is `try-shape` re-parenting a `try`/`catch` region that used to sit as a
  sibling *after* an `if` with an empty `else` into that `else` branch (e.g.
  fn#194 "value"), which is the spec-22 shape.
- No function gained or lost a `try`/`catch`: 26 `catch` lines move, 26 appear,
  26 disappear, net zero.
- No `__hbc_*` helper call appears or disappears anywhere in the diff.
