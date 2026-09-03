# 2026-09-04 — v99 async/shared-range: NOT a decompiler bug (toolchain artifact) (lean Sonnet)

98k tokens, 40 calls. Commit 197e4f3 (docs-only, gate 1952/0). PUSHBACK P-14.

- ROOT CAUSE: fixture v99.hbc compiled with tools/hermesc/v99 (hermes-compiler 260318099) but the D14 oracle runs it under tools/hermes-vm/v99 (source-built commit 913d31acd10a) — the two disagree on GetBuiltinClosure b58 (async driver) -> _makeAsyncIterator crash. NOT a decompiler bug; our output is correct.
- Proof: a BARE async function (no shared range) reproduces the identical crash under the mismatched pairing; recompiling the same source with the VM's OWN matched hermesc runs clean vs expected.txt. "Shared exception range" was a red herring. Same class as 5 existing v99 VM_LIMITATIONS entries incl. 54-try-catch-finally-shared-range (which already names this _makeAsyncIterator mode).
- Did NOT ship: the sound fix (add 43 to VM_LIMITATIONS -> routes to expected-txt reference) would invert ladder-d14-override.test.ts's hard assertion that 43 stays DIVERGENT. Correctly stopped -> P-14.
- ORCHESTRATOR READ: diagnosis ACCEPTED (evidence strong). BIG IMPLICATION: the 191 reclassified "candidate-vs-VM" divergences may be largely this same compiler/VM commit-mismatch artifact, not decompiler bugs. Next: quantify across the 191 before any per-signature fixing; the real fix may be a one-line harness compiler/VM version match, not 191 fixes. P-14 resolution (VM_LIMITATIONS + soundness-test fixture swap) held pending that investigation + a review.
