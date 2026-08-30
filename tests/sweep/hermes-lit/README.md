# tests/sweep/hermes-lit

Harvested from facebook/hermes's own MIT-licensed lit test suite
(`test/hermes/*.js`), per `docs/TASKS.md` T1 and `docs/TEST-CORPUS.md` §1b
(`docs/DECISIONS.md` D13/D16: sweep tier, not the gate).

Each `cases/<name>/` holds:

- `source.js` — the original Hermes test program, with only its `// RUN:` and
  `// CHECK...` lit-test directive lines stripped (everything else, including
  the upstream copyright header, is untouched).
- `expected.txt` — the exact stdout the file must produce, derived
  mechanically from its `// CHECK`/`// CHECK-NEXT`/`// CHECK-LABEL`/
  `// CHECK-EMPTY` lines and then *verified* by actually running the file
  under Node with the project's standard `print` shim
  (`globalThis.print ??= (...a)=>console.log(...a);`, same shim
  `tests/fixtures/build.sh` uses) and diffing byte-for-byte.

`tests/sweep/hermes-lit.test.ts` runs every case this way as an ongoing sweep
check — see that file for the runner, and `PROVENANCE.md` for exact harvest
numbers, the harvested commit, and every excluded file with its reason.

## Why only some lit tests convert

Hermes's `test/hermes/*.js` files are LLVM-lit tests: a header comment gives
one or more `// RUN: %hermes ... %s | %FileCheck ...` invocations, and
`// CHECK` comments pin expected output lines. Many of these files exist to
check the *compiler's* bytecode/AST dump (`-dump-bytecode`, `-target=HBC`
without `-emit-binary` piped to a VM run) or to assert that compilation
*fails* — neither has anything to do with a program's runtime stdout, so
neither converts to a runtime `expected.txt` no matter how it's massaged.
Of the rest, some use FileCheck directives (`CHECK-NOT`, `CHECK-DAG`,
`CHECK-SAME`, `{{regex}}`) whose "absent/unordered/pattern" semantics don't
fit a single linear expected-output file. And even a syntactically eligible
file can turn out to run differently under Node than under the Hermes VM
(microtask tick ordering, `Date`/locale formatting, property enumeration
order, JIT/GC-timing-sensitive output) — `async-function.js` is a documented
example: it exists specifically to pin Hermes's async microtask tick
ordering, which Node's differs from.

The harvest script (`tools/harvest-hermes-lit.ts`) filters for all of this
and only writes out a case when the *empirical* Node run matches the
CHECK-derived expected output exactly — see its header comment for the full
rule, and `PROVENANCE.md`'s "Excluded files" section for the per-file reason
every excluded `test/hermes/*.js` file didn't make it in.

## Regenerating

```sh
git clone --filter=blob:none --no-checkout https://github.com/facebook/hermes /tmp/hermes
git -C /tmp/hermes sparse-checkout init --cone
git -C /tmp/hermes sparse-checkout set test/hermes LICENSE
git -C /tmp/hermes checkout
node tools/harvest-hermes-lit.ts /tmp/hermes/test/hermes --commit "$(git -C /tmp/hermes rev-parse HEAD)"
```

This overwrites `cases/`, `LICENSE`, and `PROVENANCE.md` in place. Review the
diff (a Hermes update can add, remove, or change the runtime behaviour of
existing tests) before committing.

## Licence

`LICENSE` in this directory is Hermes's own MIT licence, copied verbatim from
the harvested commit (sha256 recorded in `PROVENANCE.md`). Hermes is used
here as source material (permitted, MIT), never as a behaviour oracle read
during implementation — that restriction is about hermes-dec (AGPL), see
`docs/AGENT-BRIEF.md`'s hard rules.
