# tests/sweep/test262/ — provenance

T2 (docs/TASKS.md): a curated test262 subset, harvested for control flow,
generators, try/finally and closures. See docs/TEST-CORPUS.md §1b for why
test262 is treated as "a large but low-density edge-case reservoir to dip
into" rather than adopted wholesale, and `tools/test262-harvest.mjs`'s header
comment for the full selection/generation/verification algorithm.

## Source

- Repo: https://github.com/tc39/test262
- Licence: BSD-3-Clause (verbatim text: `LICENSE` in this directory, copied
  unmodified from the checkout's root `LICENSE`)
- Commit harvested from: `771005236e88a909635104e03ba12559688c0172`
- Directories drawn from: `harness/`, `test/language/statements/{if,switch,
  for,for-in,for-of,while,do-while,break,continue,labeled,try,generators,
  function}`, `test/language/expressions/{generators,function,
  arrow-function}`, `test/built-ins/GeneratorFunction`.

## Counts (this harvest)

| | selected tests | runnable files |
|---|---|---|
| control-flow | 89 | 172 |
| generators | 45 | 86 |
| try-finally | 30 | 56 |
| closures | 26 | 31 |
| **total** | **190** | **345** |

Excluded by flag (see `manifest.json`'s `excluded` field): 4 `module`-flagged,
1 `async`-flagged — both classes excluded entirely, for the reasons in
`tools/test262-harvest.mjs`'s header (no ESM loader wired up; no
`$DONE`/timeout protocol for `doneprintHandle.js`).

Dropped after empirical verification (`manifest.json`'s `divergentFromNode`):
2 files whose actual behaviour under Node (via `vm.Script`/`vm.createContext`
— see `support/run-case.mjs`) did not match their frontmatter's expectation.
Both are Node/V8 conformance gaps unrelated to hbc2js, not something a fix
here could address:

- `test/language/statements/labeled/decl-fun-strict.js` (strict): test262
  expects a strict-mode `SyntaxError` for a labelled function declaration;
  V8's parser accepts it (a documented Annex B / de-facto web compat
  leniency), so the test's own `$DONOTEVALUATE()` guard fires instead.
- `test/language/expressions/function/scope-name-var-open-strict.js`
  (strict): expects a `TypeError` when a strict-mode function's named-
  function-expression binding is reassigned from within a nested `var`;
  V8 does not raise it under this exact interaction. Also an Annex B/engine
  leniency gap, not a spec-vs-hbc2js divergence.

Result: 345/345 kept files pass under Node (100%), verified both at harvest
time and by the regression test `tests/sweep/test262/corpus.test.ts`.

## Regenerating

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/tc39/test262.git /tmp/test262
cd /tmp/test262 && git sparse-checkout set harness test/language test/built-ins
cd -
node tools/test262-harvest.mjs --src /tmp/test262
```

The full test262 checkout (harness/ + test/language/ + test/built-ins/) is
**not** vendored into this repo — even sparse it is >100MB, and only the
directories above are ever read. `tools/test262-harvest.mjs` is idempotent:
it wipes and regenerates `cases/` and `manifest.json` on every run.

## Ground truth (D14)

This corpus's "does it pass" question is answered against Node/V8's own
`vm.Script`/`vm.createContext` (true ECMAScript *Script*-goal semantics —
see `support/run-case.mjs` for why plain `node file.js`/`file.cjs` does not
reproduce that inside this repo). That is deliberate and different from the
decompiler's own ground truth: per D14 (docs/AGENT-BRIEF.md), a *decompiled*
`.hbc` function's correctness is judged against the Hermes VM, never against
Node, because Hermes and Node/V8 deliberately diverge on some semantics
(per-iteration `let` capture, TDZ timing, sloppy `arguments` aliasing). This
harvest does not compile anything through `hermesc` or judge decompiler
output — it only curates and verifies a source-JS corpus for later use as
fixture input — so D14 does not bite here, but a future pass that turns these
into `.hbc` fixtures and runs them through hbc2js must re-verify against the
Hermes VM, not assume Node's answer still holds.
