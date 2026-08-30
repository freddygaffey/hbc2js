# Toolchain — getting `hermesc` (and friends) working locally

This documents how to get a working Hermes bytecode compiler (`hermesc`) on macOS
(Apple Silicon or Intel) and Linux (x86_64), without building Hermes from source,
and without committing binaries to the repo.

## TL;DR

```sh
tools/get-hermesc.sh all        # fetches v84, v94, v99 into tools/hermesc/v<N>/ (gitignored)
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
| 98 | `hermes-compiler@250829098.0.x` (`latest` dist-tag) | RN 0.86–0.87 (current `latest`) | |
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
tools/get-hermesc.sh 99     # → tools/hermesc/v99/hermesc
tools/get-hermesc.sh all    # all three
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
