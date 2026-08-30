# expensify-app-0.86.0 — hardened (C4) variant

Per `docs/DECISIONS.md` D16 category **C4**: the same MIT-licensed
`index.android.bundle` from `../BUILD.md`, run through
`javascript-obfuscator@5.6.0` (BSD-2-Clause, invoked via `npx --yes
javascript-obfuscator@5.6.0`, pinned version, not a repo dependency), then
recompiled with `tools/hermesc/v98/hermesc -O`.

Only the **"light" config** was attempted for this app — see the
react-navigation fixture's `hardened/BUILD.md` for why: the originally
specified "heavy" config (control-flow-flattening threshold 0.75 +
dead-code injection) does not finish compiling even on the much smaller
react-navigation bundle (killed after 6+ minutes), so it was not worth
attempting on a bundle over 10x larger.

## Config — "light" (same as react-navigation's): two obstacles, both worked around

```sh
NODE_OPTIONS="--max-old-space-size=8192" npx --yes javascript-obfuscator@5.6.0 \
  index.android.bundle.js \
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
  -out=hardened/expensify-app.hardened.hbc \
  hardened/index.android.bundle
```

**Obstacle 1 — obfuscator OOM at default heap size.** A first attempt with
default Node heap limits crashed with `FATAL ERROR: Ineffective
mark-compacts near heap limit Allocation failed - JavaScript heap out of
memory` after ~24s wall-clock, processing the 38.6 MB source. Retried with
`NODE_OPTIONS="--max-old-space-size=8192"` (8 GB) — succeeded in **2m30.94s**
(188.16s user, 132% CPU — some GC parallelism), producing an 84.5 MB
obfuscated bundle (2.2x expansion, a much smaller ratio than
react-navigation's 2.3x-at-light-config despite the much bigger input,
consistent with per-function overhead dominating at small scale and
string-array/flattening overhead being closer to linear at this scale).

**Obstacle 2 — none, this time.** Unlike the react-navigation "heavy"
config, `hermesc -O` on this 84.5 MB "light"-obfuscated bundle compiled
cleanly in **44.0s** (42.81s user) with only **37 warnings** — confirming
again (at 25x the file size) that it's specifically the *heavy* config's
combination of aggressive control-flow flattening + dead-code injection
that produces the pathological warning volume, not obfuscation or bundle
size per se.

| Artifact | Size | sha256 |
|---|---|---|
| `index.android.bundle` (obfuscated, "light" config) | 84,543,209 bytes (80.6 MB) | `d3f3cfbceaca94f7f5f2786eb4fd610f742bc9a8990c62425a75a1d1155664b1` |
| `expensify-app.hardened.hbc` (`-O`) | 79,770,713 bytes (76.1 MB) | `0d0e0f6da9684b8dff7ebe7aa04d0daadba0b3dc8073b0489a25c6c745781a43` |

`hbc-file-parser` parses it cleanly: magic/version as expected (v98),
**FunctionCount 131,424** (0x20160, up from the unobfuscated 98,775 —
control-flow flattening and string-array wrapper functions add real
functions, not just bytecode volume, even at threshold 0.1).

Run `./fetch.sh` in this directory to regenerate (fetches the parent
fixture's `index.android.bundle` first if not already present; needs
`NODE_OPTIONS`'s larger heap baked in).
