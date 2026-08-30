# react-navigation-example-0.85.3 — hardened (C4) variant

Per `docs/DECISIONS.md` D16 category **C4**: the same MIT-licensed
`index.android.bundle` from `../BUILD.md`, run through
`javascript-obfuscator@5.6.0` (BSD-2-Clause, invoked via `npx --yes
javascript-obfuscator@5.6.0`, pinned version, not a repo dependency), then
recompiled with the same `tools/hermesc/v98/hermesc -O`.

Two configs were tried. Not committed either way (both over 3 MB) — `fetch.sh`
regenerates the one that succeeds (`light`); the `heavy` config's outcome is
recorded here as a finding, not reproduced by `fetch.sh`, since it doesn't
produce a usable fixture.

## Config A — "heavy" (the originally-specified config): **does not complete**

```sh
npx --yes javascript-obfuscator@5.6.0 index.android.bundle.js \
  --output hardened/index.android.bundle \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.75 \
  --dead-code-injection true \
  --dead-code-injection-threshold 0.4 \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --self-defending false
```

Obfuscation itself succeeds (~20s, 3.36 MB → 16.9 MB — a 5x size increase
from control-flow flattening + dead-code injection).

`hermesc -O -emit-binary` on that 16.9 MB output **did not finish**: killed
after 6m35s wall-clock (6m20s CPU) with no output file produced, still
actively emitting warnings when killed (not hung/deadlocked — genuinely
still working through the file). A second attempt **without** `-O` (plain
`-emit-binary`) also failed to finish within a further ~2 minutes before
being killed. Root cause, established from the warning log
(`rn-nav-hardened-noO.log` — not committed, 9,389 `warning: the variable
"_0x..." was not declared` lines, each one re-printing the *entire* matching
source line as context): javascript-obfuscator's control-flow flattening
turns most of the bundle into deeply-nested single-line dispatcher/object
literals, so each per-function "undeclared free variable" warning's caret
diagnostic reprints an enormous single line (typically tens to hundreds of
KB) in full. With ~9,400 such warnings against lines of that size, warning
*I/O* dominates — this reads as a genuine scalability cliff in `hermesc`'s
diagnostic printer when fed heavily-flattened/minified input, independent of
whether the underlying compile would otherwise succeed. This is directly
relevant to `docs/DECISIONS.md` D3 (round-trip recompilation as the
scalable correctness oracle for real bundles): a decompiler pipeline that
shells out to `hermesc` for round-trip verification of obfuscated targets
needs to suppress/redirect warnings (e.g. a low `-w` verbosity or piping
stderr to `/dev/null`) or it can spend many minutes on diagnostic printing
alone before compilation even finishes.

**Not retried with warnings suppressed** (out of this task's per-app time
budget) — flagged for whoever picks up C4/obfuscation-hardening work next.

## Config B — "light" (reduced thresholds): **succeeds**

```sh
npx --yes javascript-obfuscator@5.6.0 index.android.bundle.js \
  --output hardened/index.android.bundle \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.1 \
  --dead-code-injection false \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.5 \
  --self-defending false

tools/hermesc/v98/hermesc -O -emit-binary \
  -out=hardened/react-navigation-example.hardened.hbc \
  hardened/index.android.bundle
```

Obfuscation: ~9.1s, 3.36 MB → 7.61 MB (2.3x). Compile: **3.7s total** (3.59s
user) — only 38 warnings, same "undeclared free variable" class but at a
volume `hermesc` handles trivially. Confirms the heavy config's slowdown is
specifically about *volume of large-line warnings*, not obfuscated bytecode
compilation being inherently slow.

| Artifact | Size | sha256 |
|---|---|---|
| `index.android.bundle` (obfuscated, "light" config) | 7,614,978 bytes (7.26 MB) | `9e1773bbb70fddd3c5db98516f2f2b3b86253c83df2b657bafc64ddc0f45bd33` |
| `react-navigation-example.hardened.hbc` (`-O`) | 7,174,304 bytes (6.84 MB) | `ffb1bb148e07c2a38d907b42aa503dbc9cd80a75821a7278e0f8055e647be1a7` |

`hbc-file-parser` parses it cleanly (magic/version as expected, v98).

Run `./fetch.sh` in this directory to regenerate the "light" pair from the
parent fixture's `index.android.bundle` (fetches it first via the parent's
own `fetch.sh` if not already present).
