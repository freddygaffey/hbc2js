// Regression fixture for fuzz family F2 (docs/BUGS.md 2026-09-04 row, reduced
// from tests/fixtures/adversarial/46-fuzz-let-capture-branch): a value computed
// into a register that hermesc immediately reuses as a `for` loop's *limit*, so
// after the for-header pass the loop reads `for (rX = 2, rY = 0; rY < rX; ...)`.
// expr-rebuild used to fold the earlier, already-dead definition of rX into the
// loop test (`rY < "" + outer`, i.e. `0 < "0"`, so the loop never ran at all),
// because a `for`'s `init` -- which executes before the first `test` -- was
// invisible to its scans: `topLevelExprOf` names only `test`, the one field the
// rewriter may fold into.
//
// `outer` is a module-level `let` captured and reassigned by a closure, so
// hermesc cannot constant-fold it away; `0 === (outer + '')` then compares a
// number against a provably-string operand, so hermesc drops the comparison and
// emits only the else branch, leaving a dead `AddEmptyString rX` immediately in
// front of the loop's `LoadConstUInt8 rX, 2`. The leading one-iteration loop is
// what makes hermesc allocate the shared constants first, so nothing at all
// separates the dead store from the `for` header.
let outer = 0;
function bump() {
  outer = outer + 1;
}
function loopAfterDeadConcat() {
  for (let i = 0; i < 1; i++) {
    print(i, true);
  }
  if (0 === (outer + '')) {
    print('unreachable: 0 === "0" is false');
  } else {
    for (let i = 0; i < 2; i++) {
      print(i, true);
    }
  }
  return `v-${true}`;
}
bump();
print('ret', loopAfterDeadConcat());
print('outer', outer);
