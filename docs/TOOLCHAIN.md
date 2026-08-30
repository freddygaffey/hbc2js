# Toolchain — getting `hermesc` (and friends) working locally

This documents how to get a working Hermes bytecode compiler (`hermesc`) on macOS
(Apple Silicon or Intel) and Linux (x86_64), without building Hermes from source,
and without committing binaries to the repo.

## TL;DR

```sh
tools/get-hermesc.sh all        # fetches v84, v94, v98, v99 into tools/hermesc/v<N>/ (gitignored)
tools/hermesc/v94/hermesc -emit-binary -out=out.hbc input.js
```

## Where the binaries come from

Hermes ships `hermesc` prebuilt for host platforms via npm, piggybacked on the
React Native release process. Two distribution shapes exist depending on era:

1. **Old (RN ≤ 0.82ish):** the `react-native` npm package itself bundles
   `sdks/hermesc/{osx-bin,linux64-bin,win64-bin}/hermesc`. Also, standalone
   `hermes-engine`/`hermes-engine-cli` packages shipped the same binaries
   independently for earlier RN releases (`hermes-engine-cli` also bundles
   `hbcdump`, `hdb`, `hermes` — useful extras). Both `hermes-engine` and
   `hermes-engine-cli` are now marked deprecated on npm but the historical
   versions still download fine.
2. **New (RN ≥ 0.83, current "1000.x" versioning):** `hermesc` moved out of
   `react-native` into its own package, **`hermes-compiler`**, at
   `hermesc/{osx-bin,linux64-bin,win64-bin}/hermesc`. `react-native`'s own
   `package.json` now just depends on a pinned `hermes-compiler` version.

There is no `win64-bin` handling in `tools/get-hermesc.sh` (out of scope: repo
targets macOS + Linux per `CLAUDE.md`), but the packages carry Windows binaries
too if ever needed.

`hermes-compiler` did **not exist as a separate package** before ~September
2025; for any HBC version prior to that transition, use the `react-native` or
`hermes-engine-cli` route instead.

All binaries checked below are Mach-O **universal** (x86_64 + arm64) on macOS,
so they run natively on Apple Silicon, and ELF x86_64 on Linux. **There is
currently no publicly published Linux arm64 `hermesc` build** in any of these
packages — if you need one, you must build Hermes from source for that target
(out of scope here); `tools/get-hermesc.sh` prints a warning and attempts the
x86_64 binary anyway (works under Rosetta/qemu-user/box64 emulation only).

## Version table (HBC bytecode version → npm source → RN release)

Determined empirically: for each candidate package version, extract
`osx-bin/hermesc`, compile a trivial `.js` file with `-emit-binary`, and read
byte offset 8 as a little-endian `uint32` (or just run `hermesc --version`,
which prints it directly as "HBC bytecode version").

| HBC version | npm source | Approx. RN release | Notes |
|---|---|---|---|
| 74 | `hermes-engine-cli@0.5.0`–`0.6.0` | RN ~0.61–0.62 | |
| 76 | `hermes-engine-cli@0.7.0`–`0.7.2` | RN ~0.63 | |
| 83 | `hermes-engine-cli@0.8.0` | RN ~0.64 (early) | |
| **84** | **`hermes-engine-cli@0.8.1`** (also `0.9.0`–`0.11.0`) | RN 0.64–0.69 | **Used by `tools/get-hermesc.sh 84`.** Also ships `hbcdump`, `hdb`, `hermes` (interpreter), `hermes-repl`. |
| 85 | `react-native@0.69.6` (`sdks/hermesc/`) | RN 0.69 | react-native itself started bundling hermesc here |
| 89 | `react-native@0.70.15` | RN 0.70 | |
| 90 | `react-native@0.71.19` | RN 0.71 | |
| **94** | **`react-native@0.72.17`** (`sdks/hermesc/`) | RN 0.72 | **Used by `tools/get-hermesc.sh 94`. Byte-identical to `tests/fixtures/hermes-dec-sample/v94.hbc`** — see verification below. |
| 96 | `react-native@0.73.11` through `0.81.6`, and `hermes-compiler@0.14.0`–`0.17.0` | RN 0.73–0.81 | Bytecode version 96 spans several years and both distribution mechanisms — the RN→hermes-compiler split (RN 0.83) happened without a version bump. |
| **98** | **`hermes-compiler@250829098.0.10`** (also `.0.0`–`.0.17`, `latest` dist-tag family) | RN 0.86–0.87 (current `latest`) | **Used by `tools/get-hermesc.sh 98`. Every published `250829098.0.x` patch probed (`.0.0-alpha.1`, `.0.0`, `.0.10`, `.0.14` — the exact version `react-native@0.86.0` depends on, `.0.17`) emits the "98-late" (class E, v99-shaped) header layout, never "98-early" (class D, v97-shaped) — see below.** |
| **99** | **`hermes-compiler@260318099.0.0` / `.1`** (`latest-v1` dist-tag) | RN "1000.x" line | **Used by `tools/get-hermesc.sh 99`. Same bytecode *format* version as `tests/fixtures/hermes-dec-sample/v99.hbc` but NOT byte-identical** — see below. |

`hermes-compiler`'s version numbers past `0.17.0` look like `YYMMDD+build.MAJOR.MINOR`
(e.g. `260318099` ≈ 2026-03-18, sequence 099) rather than semver-for-humans;
treat them as opaque and pin exact versions, don't rely on ordering intuition.

Full research trail (every version probed, tarball listings, `--version`
output) is not preserved as a file — re-derive with the same method above if
the table ever needs extending.

## Installing

```sh
tools/get-hermesc.sh 84     # → tools/hermesc/v84/{hermesc,hbcdump,hdb,hermes}
tools/get-hermesc.sh 94     # → tools/hermesc/v94/hermesc
tools/get-hermesc.sh 98     # → tools/hermesc/v98/hermesc
tools/get-hermesc.sh 99     # → tools/hermesc/v99/hermesc
tools/get-hermesc.sh all    # all four
```

The script uses `npm pack <pkg>@<version>` to fetch just the tarball (no
`npm install`, no dependency tree, no lockfile changes), extracts the
platform-appropriate binary directory (`osx-bin` on Darwin, `linux64-bin` on
Linux), copies out `hermesc` (+ siblings when present), and cleans up. It's
idempotent — reruns skip already-installed versions. `tools/hermesc/` is
gitignored; nothing here is committed.

Requires: `npm`, `tar`, `bash`. No global installs.

## Verification: byte-identical recompilation

`tests/fixtures/hermes-dec-sample/source.js` is the single source for all versions (the original v94.js/v99.js were identical; diff
is empty) compiled twice under different Hermes versions. The debug info
records the compiled file's name, so it must be invoked as `sample.js` in the
current directory to match (the original fixture author evidently ran
`hermesc sample.js`, not an absolute path — filenames get embedded in the debug
string table even without any `-g` flag).

```sh
cp tests/fixtures/hermes-dec-sample/source.js /tmp/sample.js
cd /tmp
/path/to/tools/hermesc/v94/hermesc -emit-binary -out=v94_out.hbc sample.js
cmp v94_out.hbc /path/to/tests/fixtures/hermes-dec-sample/v94.hbc
# → no output, exit 0: BYTE-IDENTICAL
```

**v94: byte-identical.** `react-native@0.72.17`'s bundled `hermesc`, invoked
with no flags beyond `-emit-binary -out=...`, reproduces `tests/fixtures/hermes-dec-sample/v94.hbc`
exactly.

```sh
cp tests/fixtures/hermes-dec-sample/source.js /tmp/sample.js
cd /tmp
/path/to/tools/hermesc/v99/hermesc -emit-binary -out=v99_out.hbc sample.js
cmp v99_out.hbc /path/to/tests/fixtures/hermes-dec-sample/v99.hbc
# → differs (2981 bytes vs. 2999 bytes)
```

**v99: NOT byte-identical, and no publicly-downloadable npm package currently
reproduces it.** Both share HBC format version 99 and the disassembly is
almost entirely identical, but `hbc-disassembler` (hermes-dec) shows two real
differences, not flag differences:

1. **A different built-in function table.** Our recompile's `GetBuiltinClosure`
   resolves builtin `#58 makeAsyncIterator`; the fixture resolves builtin
   `#57 spawnAsync` at the same call site. The built-in index table is baked
   into the compiler binary — a different table means a genuinely different
   Hermes source commit, not a flag or optimization-level difference.
2. **An extra `Unreachable` instruction** at the end of two generator/async
   function bodies (`gen`, `?anon_0_testx`) in the fixture that our recompile's
   codegen omits — a 1-byte-per-function difference in dead-code-instruction
   emission between compiler commits.

Tried and ruled out as the cause: `-O0`, `-g`/`-g0` (debug info level),
`-fstatic-builtins`/`-fno-static-builtins`, and the very next published
`hermes-compiler` patch (`260318099.0.1` — byte-identical output to `.0.0`, so
it isn't a patch-level fix either). Conclusion: **"bytecode version 99" is a
wire-format compatibility version, not a compiler build version** — many
different Hermes commits over time can all emit format-version-99 bytecode
while differing in instruction selection and builtin ordering.
`hermes-compiler@260318099.0.x` is the closest and only publicly-obtainable
match (correct format version, semantically equivalent output); reproducing
`tests/fixtures/hermes-dec-sample/v99.hbc` byte-for-byte would require the exact internal Hermes
commit that produced it, which is not published to npm as of this writing.
This is why `docs/DECISIONS.md` D3 normalizes register/label names for
structural diffing rather than relying on byte equality for real-world
bundles — the same reasoning applies here.

## v98: which header layout does the public package emit?

`docs/HBC-FORMAT.md` sec 0/0.1 (D8) documents that a file reporting HBC
version 98 can be in one of two incompatible header layouts: class D
("98-early", 19 header `uint32`s, 19 bytes of trailing padding, same shape as
v97) or class E ("98-late", 20 header `uint32`s, 15 bytes of padding, adds
`numStringSwitchImms`, same shape as v99) — the D→E-shaping commit landed
*before* the version was bumped to 99, so both layouts can legitimately claim
to be "version 98".

**Probed directly** (compile `tests/fixtures/hermes-dec-sample/source.js`
with each candidate, then read header bytes per `docs/HBC-FORMAT.md` §2 —
try both the class-D and class-E field offsets and see which produces an
all-zero padding region *and* a `debugInfoOffset` that's `0 < x <= fileLength`):

| Package probed | Hermes release string | Layout |
|---|---|---|
| `hermes-compiler@250829098.0.0-alpha.1` | `0.12.0` (stale version string, still HBC 98) | class E |
| `hermes-compiler@250829098.0.0` | `250829098.0.0` | class E |
| `hermes-compiler@250829098.0.10` | `250829098.0.10` | class E |
| `hermes-compiler@250829098.0.14` (what `react-native@0.86.0` itself depends on) | `250829098.0.14` | class E |
| `hermes-compiler@250829098.0.17` (newest patch at probe time) | `250829098.0.17` | class E |

**Every publicly-obtainable `hermes-compiler` build claiming HBC version 98,
across the full patch range from first alpha to newest, emits only the
"98-late" (class E) layout.** No package producing "98-early" (class D) was
found — consistent with `docs/HBC-FORMAT.md`'s observation that the
D→E-reshaping commit predates the first `98` npm publish; whatever produced
"98-early" bytecode apparently never got packaged and shipped externally
(only internal/CI builds between the `97` and `98` bumps, if any, would have
seen it). `tools/get-hermesc.sh 98` pins `250829098.0.10` (mid-range patch,
arbitrary among the equivalent options) — **so `tests/fixtures/hermes-dec-sample/v98.hbc`
and every construct fixture's `v98.hbc` are class-E-layout files.** A parser
that only ever sees a real-world "98" file from this toolchain will never
exercise the class-D branch of the D8 probe ladder from a fixture alone; that
branch remains untested against real bytecode (same status as before this
work — just now documented as a known, not merely suspected, gap).

## Disassembling

Two independent disassemblers are available; useful to cross-check each other
per `docs/DECISIONS.md` D3.

**1. `hermesc -dump-bytecode`** (MIT-licensed, matches the compiler exactly by
construction — always use the *same-version* `hermesc` as the file's HBC
version):

```sh
tools/hermesc/v94/hermesc -dump-bytecode tests/fixtures/hermes-dec-sample/v94.hbc   # from source, if you still have it
# or, given only a .js file:
tools/hermesc/v94/hermesc -dump-bytecode input.js
```

Note: `-dump-bytecode` (unlike `-emit-binary`) takes the **source** `.js`, not
a `.hbc` file — hermesc recompiles it and dumps the IR/bytecode text instead of
writing a binary. To dump text from an *existing* `.hbc` binary, use `hbcdump`
(below) or hermes-dec's disassembler.

**2. `hbcdump`** (also MIT, comes bundled with `hermes-engine-cli`, e.g.
`tools/hermesc/v84/hbcdump`) reads a compiled `.hbc` binary directly, but is
strictly version-locked to the bytecode version its own build was compiled
for:

```sh
tools/hermesc/v84/hbcdump -c "quit" tests/fixtures/v84_something.hbc
# tools/hermesc/v84/hbcdump against a v94 or v99 file fails hard:
#   Error: fail to deserializing bytecode: Wrong bytecode version. Expected 84 but got 94
```

Since no `hermes-compiler`/`react-native` release after the early
`hermes-engine-cli` era ships `hbcdump` as a separate binary, in practice you
only get `hbcdump` for v84-era files from this toolchain; for v94/v99 use
`hermesc -dump-bytecode` on the source, or hermes-dec below.

**3. `hbc-disassembler`** (Python, AGPL, `pip install hermes-dec` — already
installed in this environment at version 0.1.7). Per `CLAUDE.md`, this is a
**behaviour oracle only** — read its output, never its source:

```sh
hbc-disassembler tests/fixtures/hermes-dec-sample/v94.hbc out.disasm
hbc-decompiler tests/fixtures/hermes-dec-sample/v94.hbc out.decompiled.js   # pseudo-code, not valid JS (see SPEC.md)
hbc-file-parser tests/fixtures/hermes-dec-sample/v94.hbc                     # header/section dump
```

Confirmed working entry points from the `hermes-dec` 0.1.7 install:
`hbc-disassembler`, `hbc-decompiler`, `hbc-file-parser`,
`hermes-dec-regen-html`, `hermes-dec-regen-pydefs`,
`hermes-dec-regen-pydefs-regexp`. `hbc-disassembler` emits a warning for v99
("corresponds to a development or recent version... not formally supported")
but produces correct output anyway (verified above via the builtin-table /
`Unreachable`-instruction diff, which required trusting its disassembly).

## Determining a `.hbc` file's bytecode version yourself

Byte offset 8, 4 bytes, little-endian `uint32` (right after the 8-byte magic
number `c6 1f bc 03 c1 03 19 1f`):

```sh
python3 -c "
import struct
with open('file.hbc','rb') as f:
    data = f.read(16)
print('magic:', data[:8].hex())
print('version:', struct.unpack('<I', data[8:12])[0])
"
```

or, if you have any `hermesc` handy that's new enough to at least parse the
header: `hermesc -dump-bytecode` on the corresponding source won't help for an
unknown binary — prefer the byte offset above, or `hbc-file-parser` from
hermes-dec.

## Hermes VM (source build)

`tools/get-hermesc.sh` only ever gets a `hermesc` **compiler**; the only
prebuilt `hermes` **VM/interpreter** available on npm is bundled with
`hermes-engine-cli`, whose last release (`0.12.0`) tops out at HBC 89 and hard-
refuses newer bytecode (`Error deserializing bytecode: Wrong bytecode version.
Expected 89 but got 94`). `docs/EQUIVALENCE.md` §5 needs a VM for v94 and v99
to use as the ground-truth oracle (D14) instead of Node, so
`tools/build-hermes-vm.sh <94|99>` builds `hermes` (+ `hermesc`, `hbcdump`)
from source at the facebook/hermes commit that produced each version.

```sh
tools/build-hermes-vm.sh 94   # → tools/hermes-vm/v94/bin/{hermes,hermesc,hbcdump}
tools/build-hermes-vm.sh 99   # → tools/hermes-vm/v99/bin/{hermes,hermesc,hbcdump}
tools/hermes-vm/v94/bin/hermes -b tests/fixtures/hermes-dec-sample/v94.hbc
```

`tools/hermes-vm/` is gitignored; nothing here is committed, same policy as
`tools/hermesc/`.

### Commit selection

| Version | Commit | Date | Message | How found |
|---|---|---|---|---|
| 94 | `3815fec63d1a6667ca3195160d6e12fee6a0d8d5` | 2024-04-26 | "Removing API usage not applicable on iOS (stat and fstat) in libhermes" | `react-native@0.72.17`'s `packages/react-native/sdks/.hermesversion` records `hermes-2024-04-29-RNv0.72.14-3815fec63d1a6667ca3195160d6e12fee6a0d8d5` verbatim — no guessing needed. |
| 99 | `913d31acd10aff31e0856657c9c566c3e72bd24a` | 2026-03-05 | "Revert bytecode version to 99" | This is the commit `docs/HBC-FORMAT.md` §0 already names as the one that inserts `NewTypedObjectWithBuffer` at opcode index 4, producing the 220-opcode table both `v99.hbc` and `v99-public.hbc` require (confirmed there by hand-decoding). `hermes-compiler@260318099.0.x`'s npm tarball carries no commit hash anywhere (checked: `package.json` has no `gitHead` field, `hermesc --version` prints only the npm release string, and the binary has no embedded 40-hex-char strings), so it can't be pinned more precisely than "the earliest commit with the right opcode table" — see below for how close that gets. |

Both repos were fetched with `git clone --filter=blob:none` (partial clone,
full commit graph, blobs fetched lazily on checkout) and share one object
store via `git worktree add` — cheap even though facebook/hermes is fairly
large. Note also: **facebook/react-native on GitHub now redirects to
`react/react-native`** (org rename) as of this writing; `facebook/hermes`
itself has not moved and its default branch is now `static_h`.

### Build notes (macOS, Apple Silicon, cmake 4.4.0, this environment)

- **Dependencies**: `cmake`, `git`, `python3`, a C++14 compiler (Xcode CLT
  clang). `ninja` was not preinstalled; `brew install ninja` (a few seconds,
  bottled). No ICU install needed — Hermes's `CMakeLists.txt` special-cases
  `APPLE` to skip the ICU search entirely and use the platform's built-in ICU.
- **One build fix needed, v94 only**: the v94-era top-level `CMakeLists.txt`
  unconditionally does `cmake_policy(SET CMP0026 OLD)`. CMake >= 4.0 removed
  `CMP0026`'s OLD behavior outright (not just gated behind a policy-version
  floor), so this hard-errors at configure time ("Policy CMP0026 may not be
  set to OLD behavior because this version of CMake no longer supports it").
  The only consumer of the OLD behavior (`get_target_property(... LOCATION)`
  in `API/hermes/CMakeLists.txt`) is itself gated behind
  `HERMES_BUILD_APPLE_DSYM`, which we never enable, so
  `tools/build-hermes-vm.sh` just comments the block out in its local clone
  before configuring (v99/`static_h`'s `CMakeLists.txt` has already dropped
  this block upstream — no patch needed there). No other build failures on
  either version.
- **Configure**: `cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release`.
  v99/`static_h` requires `CMAKE_BUILD_TYPE` to be set explicitly (`message
  (FATAL_ERROR "Please set CMAKE_BUILD_TYPE")` otherwise); v94 doesn't but we
  pass it either way.
- **Build scope**: `cmake --build build --target hermes hermesc hbcdump -j
  $(nproc)`. Building just these three (not `check-hermes`, not
  `node-hermes`, not the Apple `libhermes` framework, not fuzzers) is fast —
  the top-level `tools/CMakeLists.txt` still configures all of those
  subdirectories, but only the requested targets and their dependencies get
  compiled by ninja.

### Build results

Two builds ran concurrently (10 physical/logical cores, `-j10` each,
competing) on Apple Silicon (arm64):

| Version | Wall time | `hermes` release string reported | Binary sizes (hermes / hermesc / hbcdump) |
|---|---|---|---|
| 94 | 1m58s (356 ninja steps) | `Hermes release version: 0.12.0`, `HBC bytecode version: 94` | 4.0M / 2.5M / 1.2M |
| 99 | 2m22s (430 ninja steps) | `Hermes release version: 1.0.0`, `HBC bytecode version: 99` | 4.7M / 3.0M / 592K |

(Both would likely be somewhat faster built one at a time with the full core
count; still well inside the 90-minute timebox even run head-to-head.)

### Verification

**Running the fixtures under the matching VM** (`hermes -b file.hbc`):

- `tests/fixtures/hermes-dec-sample/v94.hbc` under v94: runs, then
  `Uncaught ReferenceError: Property 'window' doesn't exist` at
  `sample.js:52` — expected, bare Hermes has no `window` global; this is the
  same fixture, not a fixture bug.
- `tests/fixtures/hermes-dec-sample/v99.hbc` and `v99-public.hbc` under v99:
  same `window` ReferenceError, at the same source line, for both — meaning
  our v99 VM decodes both the original and the publicly-recompiled v99
  bytecode without a version/opcode-table mismatch (a wrong opcode table
  would misdecode the instruction stream well before reaching line 52, not
  fail cleanly at the same spot both times).
- 10 `tests/fixtures/constructs/*` fixtures run under both VMs and diffed
  against `expected.txt` (Node): `01-if-else-chain`, `09-switch-fallthrough`,
  `18-closure-loop-let`, `20-let-const-tdz`, `23-generator-basic`,
  `32-class-basic`, `37-destructuring-array`, `42-rest-params`,
  `46-bigint-arithmetic`, `49-arguments-object`. (`32-class-basic` has no
  `v94.hbc` — classes are unsupported by the v94-era IRGen, a pre-existing,
  documented gap, not new here.)

**D14's 4 known Node-vs-Hermes divergences all persist at both v94 and v99**,
confirming (not refuting) the assumption in `docs/DECISIONS.md` D14 that they
hold "at every version tested":

| Fixture | Divergence | v94 | v99 |
|---|---|---|---|
| `18-closure-loop-let` | per-iteration `let` closure capture | still collapses to one binding (`3,3,3` / `3:2` repeated) | same |
| `20-let-const-tdz` | TDZ vs. outer-`let` shadowing | still no TDZ (reads `undefined`/outer value instead of throwing) | same |
| `42-rest-params` | sloppy `arguments` aliasing | still `original` (no aliasing) instead of `mutated` | same |
| `49-arguments-object` | sloppy `arguments`/param aliasing | still `original`/`false` instead of `changed-via-arguments`/`true` | same |

All 6 other sampled fixtures matched `expected.txt` exactly under both VMs.

**`hermesc` recompilation** (`tests/fixtures/hermes-dec-sample/source.js` →
`sample.js` in cwd, per the byte-identical recipe above):

- **v94: byte-identical** to `tests/fixtures/hermes-dec-sample/v94.hbc`
  (`cmp` exit 0), same as the prebuilt npm `hermesc` — this independently
  confirms the v94 SHA is right, since a wrong commit would almost certainly
  produce different bytecode.
- **v99: matches neither `v99.hbc` nor `v99-public.hbc` byte-for-byte**, but
  is closer to `v99-public.hbc` than to `v99.hbc`: same file size (2981
  bytes, vs. `v99.hbc`'s 2999) and disassembles identically to
  `v99-public.hbc` in every respect **except one** — our build's
  `GetBuiltinClosure` resolves builtin **`#57 spawnAsync`**, matching
  **`v99.hbc` (the original, non-public commit)**, not `v99-public.hbc`'s
  `#58 makeAsyncIterator`. So our commit's builtin-numbering table sits
  between the two: newer than whatever produced `v99.hbc`, older than
  `hermes-compiler@260318099.0.x`'s actual build commit. (It also still
  lacks the extra `Unreachable` instruction `v99.hbc` has at the end of
  `gen`/`?anon_0_testx` — matching `v99-public.hbc` on that axis instead.)
  Net: `913d31acd10aff31e0856657c9c566c3e72bd24a` is a real, buildable,
  correct-opcode-table point on the `static_h` v99 timeline, but — as
  `docs/HBC-FORMAT.md` already concluded — no single publicly-identifiable
  commit reproduces `v99.hbc` exactly; ours is bracketed between it and the
  npm release rather than equal to either.
