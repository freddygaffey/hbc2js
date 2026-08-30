// D13a stress fixture: genuinely irreducible CFG, handler-driven family.
//
// Modeled on tests/fixtures/bundles/rn-template-0.72's fn#637 "wi" (React's
// commitRootImpl), read via `hbc2js disasm` -- see docs/lowering/irreducible-cfg.md
// section 2/4. That function has one exception-handler region guarding a single
// call, an if/else feeding into the guarded call from two directions, and a
// catch handler that jumps BACK to the guarded call to retry it rather than
// falling through to the code after the try/catch. Measured genuinely
// irreducible (duplicated>0) with `tools/irreducibility.mjs` at all five
// hermesc versions (84/94/96/98/99) -- see that doc for the exact counts.
//
// The retry itself is unremarkable (a while(true)+try/catch+continue is a
// completely ordinary reducible loop on its own -- see the three failed
// candidates in irreducible-cfg.md section 3). What tips this one into
// irreducibility is the if/else BEFORE the loop feeding two different paths
// into the loop's (single) guarded statement, exactly as fn#637's L1 does.
function commitWithRetry(a, flags, cont) {
  var snapshot = getCurrent();
  flags = flags | 2;
  setFlags(flags);
  var pending = pendingCallback();
  var matched = false;
  if (getState1() === a) {
    if (getState3() === cont) {
      matched = true;
    }
  }
  if (!matched) {
    clearPending();
    prepareRetry(a, cont);
  }
  while (true) {
    try {
      finishSetup();
      criticalCommit();
    } catch (e) {
      recoverFromError(a, cont, e);
      continue;
    }
    break;
  }
  finalizeAfterCommit(snapshot, pending);
  var next = getNextRoot();
  if (next !== null) {
    resetState();
    return getScheduled();
  }
  var err = getPendingError();
  if (err !== null) {
    throw new Error('Cannot commit an incomplete root without a text node.');
  }
  return getResult();
}

var STATE = { current: 'root-a', state1: null, state3: null, pending: null };
var attempts = 0;

function getCurrent() { return STATE.current; }
function setFlags(f) { STATE.flags = f; }
function pendingCallback() { return 1; }
function getState1() { return STATE.state1; }
function getState3() { return STATE.state3; }
function clearPending() { STATE.pending = null; }
function prepareRetry(a, cont) { STATE.state1 = a; STATE.state3 = cont; }
function finishSetup() { }
function criticalCommit() {
  attempts = attempts + 1;
  if (attempts < 3) throw new Error('transient failure ' + attempts);
}
function recoverFromError(a, cont, e) { STATE.lastError = e.message; }
function finalizeAfterCommit(snapshot, pending) { STATE.current = snapshot + '/' + pending; }
function getNextRoot() { return attempts > 5 ? 'next-root' : null; }
function resetState() { STATE.reset = true; }
function getScheduled() { return 'scheduled'; }
function getPendingError() { return null; }
function getResult() { return 'result:' + attempts + ':' + STATE.current + ':' + STATE.lastError; }

print(commitWithRetry('root-a', 0, 'ctx-1'));
print('attempts:', attempts);

// A second call that DOES take the "next root" early-return branch, so both
// exits of the shared join point after the loop are covered.
attempts = 6;
print(commitWithRetry('root-a', 0, 'ctx-1'));
