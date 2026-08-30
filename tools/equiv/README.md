# tools/equiv — `hbc2js-equiv`

Proof-of-concept semantic-equivalence checker for hbc2js. Design study and
rationale: [`docs/EQUIVALENCE.md`](../../docs/EQUIVALENCE.md).

Zero dependencies, Node ESM, Node >= 20 (developed on 25).

## Use

```sh
tools/equiv/hbc2js-equiv a.js b.js                 # execution-trace comparison
tools/equiv/hbc2js-equiv a.js b.js --fuzz          # + differential function fuzzing
tools/equiv/hbc2js-equiv --hbc orig.hbc decomp.js  # both sides under the Hermes VM
tools/equiv/hbc2js-equiv normalise dumpA.txt dumpB.txt   # D3 round-trip diff
```

Exit codes: `0` EQUIVALENT, `1` DIVERGENT, `2` INCONCLUSIVE, `3` harness error.
INCONCLUSIVE is a real outcome, not a soft pass — see `docs/EQUIVALENCE.md` §7.

## Verify it works

```sh
node tools/equiv/selftest.mjs --hermes --fuzz    # ~40s, whole fixture corpus
node --test 'tools/equiv/test/*.test.mjs'        # ~3s, unit tests
```

`selftest.mjs` runs three phases over `tests/fixtures/constructs/`:

1. **determinism + fidelity** — every fixture executed twice in independent
   processes must trace identically, and the `print` projection of the trace
   must equal the fixture's `expected.txt`.
2. **mutation kill rate** — deliberately broken copies of every fixture must be
   reported DIVERGENT. Survivors are printed; each is a blind spot to
   understand, and most are genuinely equivalent mutants.
3. **Hermes VM cross-check** (`--hermes`) — each fixture's own `.hbc` run under
   a matching Hermes VM, compared against the Node sandbox trace.

## Layout

```
hbc2js-equiv              CLI entry point (shell shim)
selftest.mjs              corpus-wide validation, one command
src/cli.mjs               argument parsing, verdict reporting
src/trace.mjs             trace record kinds, value encoder, canonical rendering
src/sandbox.mjs           node:vm context: host stubs, seeded PRNG, frozen clock, virtual timers
src/child.mjs             one program, one process, NDJSON trace on stdout
src/runner.mjs            spawn + wall-clock kill + NDJSON parse
src/compare.mjs           three-valued verdict and first-divergence report
src/fuzz.mjs              value corpus and seeded argument-tuple generation
src/hermes.mjs            Hermes VM discovery, HBC version probe, .hbc execution
src/normalise-disasm.mjs  D3 prototype: canonicalise `hermesc -dump-bytecode`
src/mutate.mjs            mutation operators for negative testing (comment/string aware)
examples/                 worked examples referenced from docs/EQUIVALENCE.md
test/                     node:test unit tests
```

## Status

Proof of concept. It is not wired into a build, has no `package.json`, and the
M3 harness should treat it as an executable design document rather than code to
ship as-is. `docs/EQUIVALENCE.md` §9 lists what the real harness spec must add.
