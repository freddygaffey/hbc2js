# Expensify/App — Tier 2 / C3 fixture ("large" slot)

Source: `Expensify/App` (MIT). Commit
`12a92bd39f31ddabf5a425552930cbb055536555` (shallow-cloned 2026-08-30).
`react-native` = **0.86.0** (verified `package.json` `dependencies["react-native"]`).
`node_modules/react-native/package.json` pins `hermes-compiler@250829098.0.14`
→ **HBC bytecode version 98** (same version bucket as the react-navigation
fixture, whose pinned patch is `250829098.0.10` — both are v98-format,
verified via each `.hbc`'s own header rather than assumed).

No secrets/`.env` needed to produce the bundle — confirmed directly:
`CONTRIBUTING.md`/contributor docs say "Creating an `.env` file is not
necessary. We advise external contributors against it," and the default
`npm ci` + bundle path below never referenced one.

The bundle/`.hbc` files are **not committed** — this is the deliberately
"large" Tier 2 slot (38.6 MB JS bundle, 43-51 MB `.hbc`), far over the 3 MB
threshold. Run `fetch.sh` to regenerate; sha256 + sizes below let you verify
a regenerated copy matches.

## Reproducing

```sh
git clone --depth 1 https://github.com/Expensify/App.git expensify
cd expensify
git rev-parse HEAD   # expect 12a92bd39f31ddabf5a425552930cbb055536555 (or later)

# engine-strict=true in .npmrc pins node 26.5.0/npm 11.17.0/bun 1.3.14; this
# was reproduced on node 25.9.0/npm 11.12.1 by overriding the engine check
# (harmless for a bundle-only path — no native build, no bun-specific step
# is invoked by `npm ci`/`react-native bundle`):
npm_config_engine_strict=false npm ci --ignore-scripts   # ~2 min, 3002 packages

# IMPORTANT: install watchman first (`brew install watchman` / apt), or
# Metro's file crawl races react-native-worklets' bundle-mode babel plugin,
# which writes per-worklet extraction files under
# node_modules/react-native-worklets/.worklets/<id>.js *during* the
# transform pass. Without a real filesystem watcher, Metro's one-shot CLI
# crawl doesn't reliably see a file created mid-build and throws
# "Failed to get the SHA-1 for: .../.worklets/<id>.js" — reproduced
# deterministically (2/2 tries) without watchman, gone after installing it.
# Also pass --max-workers 1: with watchman present but multiple transform
# worker *processes*, the same race still occurred once during this session
# (each worker resolves/writes independently); pinning to a single worker
# avoids any cross-process ordering issue with the shared .worklets/ dir.
brew install watchman   # or: apt-get install watchman
watchman watch .

npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output index.android.bundle \
  --assets-dest ./release-assets \
  --max-workers 1

# hermesc for HBC 98 (see docs/TOOLCHAIN.md / tools/get-hermesc.sh; the same
# v98 fetched for the react-navigation fixture works here too):
../tools/get-hermesc.sh 98
HERMESC=../tools/hermesc/v98/hermesc
$HERMESC -O -emit-binary -out=expensify-app.hbc index.android.bundle
$HERMESC -O -g -emit-binary -out=expensify-app.debug.hbc index.android.bundle
```

Or run `./fetch.sh` in this directory.

## Sizes, timing, hashes

| Artifact | Size | sha256 |
|---|---|---|
| `index.android.bundle` (JS, `--dev false`, no explicit `--minify` flag — RN's release default) | 38,610,608 bytes (36.8 MB) | `154bc6d8cd36d5d7e5c1ffc05621baae4ef8675a01c43b9a8ed50a3481aed6a1` |
| `expensify-app.hbc` (`-O`) | 45,613,676 bytes (43.5 MB) | `7777f0b45fd26c6f236add3d70ad5a1bbc9f1a6da809171915bf1db12ed3c098` |
| `expensify-app.debug.hbc` (`-O -g`) | 53,352,127 bytes (50.9 MB) | `2b26ffb2dbcb0197e5444b058baf5cfb57a04d336cc9ab28a9c875234a245aff` |

This is well past the ~12 MB "large" anchor `docs/TEST-CORPUS.md` expected —
Expensify's bundle has grown since that doc's estimate (double-digit-MB was
correctly anticipated, the exact figure wasn't).

Compile time (Apple Silicon, `tools/hermesc/v98/hermesc`, single run, `time`):
- `-O`: **32.6s total** (31.86s user)
- `-O -g`: **34.8s total** (33.73s user)

npm install: ~2 min (3002 packages, `--ignore-scripts`, engine-strict
overridden). Bundling itself (once watchman + `--max-workers 1` sidestepped
the worklets race): under a minute.

## Verification

- `hbc-file-parser expensify-app.hbc` parses cleanly (same v98
  "not formally supported" warning as the react-navigation fixture, header
  otherwise self-consistent: magic `c61fbc03c103191f`, version 98).
- `hermesc -dump-bytecode` on the source bundle completed (9.37M lines of
  disassembly text — not retained here, too large; stats below were grepped
  from it directly and cross-checked against `hbc-file-parser`'s header
  fields where both report the same count).

Header fields of note (`hbc-file-parser`):

| Field | Value |
|---|---|
| FunctionCount | 98,775 (0x181d7) — cross-checked via `-dump-bytecode`'s per-function header count: exact match |
| IdentifierCount | 74,581 (0x12555) |
| StringCount | 219,182 (0x35b2e) |
| OverflowStringCount | 1,307 |
| BigIntCount | 3 |
| RegExpCount | 2,316 |
| ObjShapeTableCount | 20,155 |
| NumStringSwitchImms | 100 — cross-checked via `-dump-bytecode`'s actual `StringSwitchImm r...` instruction count: exact match |
| CjsModuleCount | 0 |
| FunctionSourceCount | 787 |
| HasAsync | 0 |

## Decompilation-relevant characteristics

- **Metro module wrapper**: standard `__d(function(g,r,i,a,m,e,d){...}, <id>, [<dep ids>])`,
  numeric module IDs, same shape as react-navigation's bundle.
- **`require` polyfill**: standard Metro `require`/`__d`/`__r` trio.
- **Inline requires**: yes, pervasive (`r(d[n])` inline in function bodies).
- **Dynamic/split-bundle loading**: notable and specific to this app —
  `fetchThenEvalAsync(url)` fetches a JS string over the network and calls
  bare `eval(body)` on it (Hermes warns `Direct call to eval(), but lexical
  scope is not supported` at this call site); this is Metro's split-bundle
  / code-push style lazy loading. A decompiler cannot statically resolve
  what that `eval` will run — worth flagging as a real-world "opaque dynamic
  code" boundary, distinct from ordinary `require`.
- **Worklets value unpacker**: `react-native-worklets`' `installValueUnpacker`
  factory embeds a second `eval`/`globalThis.evalBytecode`/
  `evalWithSourceMap`/`evalWithSourceUrl` fallback chain for deserializing
  worklet closures at runtime (also flagged by Hermes as an unresolvable
  `eval`). Two independent "eval an opaque string built from data the
  bundle also embeds" patterns in one real app.
- **Classes**: not independently re-verified for a bytecode-level `Class`
  opcode (same caveat as the react-navigation fixture) — Expensify's babel
  preset is standard Expo/RN, so classes are expected to already be
  prototype-chain-lowered before Hermes sees them.
- **Generators**: `CreateGenerator` appears **787 times** — again real
  opcode-driven generators at HBC 98, not a compiler-lowered state machine.
- **Async**: header `HasAsync: 0`; no `CreateAsyncClosure`/`StartGenerator`
  found in the dump — consistent with the react-navigation finding that this
  Hermes build's async/await path doesn't set that flag or use those
  opcodes (async likely rides the same `CreateGenerator` + promise-glue
  path). Flagging as an open question for whoever designs generator/async
  recovery, same as noted in the react-navigation `BUILD.md`.
- **Switch jump tables**: `UIntSwitchImm` × 73, `StringSwitchImm` × 100 (173
  total) — a much larger and denser real-world sample than
  react-navigation's 36, useful for stress-testing jump-table recovery at
  scale (`ObjShapeTableCount` 20,155 and `StringCount` 219,182 are also an
  order of magnitude beyond anything in `tests/fixtures/constructs/`).
