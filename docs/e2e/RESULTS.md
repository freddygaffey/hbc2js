# E2E tier 1 — corpus round-trip results

Measured by `tools/e2e/roundtrip-corpus.ts` (docs/TESTING.md "E2E tier 1"):
split → recompile every module with the bundle's own `hermesc -O` → decode
both sides with `src/disasm` → `src/harness/roundtrip.ts` normalisation
(width variants folded) → per-function verdict. **IDENTICAL is a
bytecode-level round-trip, not a behaviour verdict**; DIFFERENT includes every
readability shape the ladder chooses on purpose. Numbers and bucket names
only — nothing from any proprietary bundle is recorded here (D16 C5).

The committed bundles' numbers are the ratchet (`docs/e2e/roundtrip-baseline.json`,
`tests/sweep/e2e/roundtrip-ratchet.test.ts`). Everything else is evidence.

## 2026-09-01 — QUEUE (e2e round-trip register/scheduling insensitivity): "strong" normalisation

`src/harness/roundtrip.ts` grew an opt-in `{ strong: true }` normalisation
(`tools/e2e/roundtrip-corpus.ts --normalise strong`, now the default) on top
of the always-on per-function register renaming: (b) maximal adjacent runs
of `LoadConst*`/`LoadParam`/`GetGlobalObject` (the only opcodes that write a
register and read none) reorder into a content-derived canonical order —
never across a jump-target label, never when two instructions in the run
share a destination register; (c) `LoadConstZero`/`LoadConstUInt8 0`/
`LoadConstInt 0`/etc. that encode the same value render identically. Both
are provably dataflow-preserving (D3): a run is only ever permuted among
itself. `--normalise legacy` reproduces the pre-QUEUE comparison for
side-by-side numbers.

**Legacy vs strong, % IDENTICAL** (macOS arm64, same measurement as below):

| bundle | mode | legacy | strong | delta |
|---|---|---|---|---|
| rn-template-0.72 | passes-off | 20.58% (849/4125) | 20.70% (854/4125) | +5 fns |
| rn-template-0.72 | passes-on | 37.28% (1538/4125) | 37.50% (1547/4125) | +9 fns |
| react-navigation-example-0.85.3 | passes-off | 28.72% (4147/14437) | 28.72% (4147/14437) | 0 |
| react-navigation-example-0.85.3 | passes-on | 32.88% (4747/14437) | 32.88% (4747/14437) | 0 |

The improvement is real but modest, and bundle-dependent: rn-template's
adjacent-run/LoadConst patterns are common enough at its scale to move the
needle; react-navigation shows none, because its residual DIFFERENTs are
already dominated by buckets this normalisation does not address (below).
`docs/BUGS.md`'s "known limit" row (2026-09-01, QUEUE e2e round-trip
register/scheduling insensitivity) explains why the biggest remaining
bucket family — `diff:GetByVal(reg)`/`diff:GetById(reg)`/
`diff:TryGetById(reg)`/`diff:LoadFromEnvironment(reg)` — is *not* fixed by
this change: it needs a per-DEFINITION register rename (a fresh canonical
name every time a register is written, not just at its first appearance),
which needs a def/use classification per opcode operand the decoder does
not expose yet; scoped out this round rather than risk a false IDENTICAL by
guessing at the "operand 0 is dest" convention's exceptions (stores,
conditional-jump operands). `docs/e2e/roundtrip-baseline.json` is bumped to
the strong numbers (`"normalisation": 2`); the ratchet only went up.

**New top-5 buckets under strong normalisation, passes-on** (each has a
`docs/BUGS.md` row, dated either 2026-09-01 "E2E tier 1" — pre-existing, the
bucket name is unchanged or only cosmetically renamed by (c)'s LoadConst
canonicalisation — or 2026-09-01 "QUEUE (e2e round-trip register/scheduling
insensitivity)" for the new register-reuse row):

| # | rn-template | react-navigation | note |
|---|---|---|---|
| 1 | `diff:LoadConst(operand)` 364 | `diff:TryGetById(string)` 1423 | rn-template's is (c)'s canonicalisation folding the old `CreateEnvironment/LoadConst*` register-prologue bucket (BUGS row 2026-09-01) into one name; still the same root cause |
| 2 | `diff:TryGetById(string)` 287 | `diff:LoadFromEnvironment(imm)` 1413 | both pre-existing BUGS rows (dead `globalThis` load; captured-variable slot order) |
| 3 | `diff:GetById/LoadConst` 169 | `diff:CreateFunctionEnvironment(imm)` 677 | rn-template's is the `LoadThisNS`-coercion BUGS row, renamed by (c) | 
| 4 | `diff:PutNewOwnById/PutById` 155 | `tree:unmatched-closure(orig 1 vs recompiled 0)` 630 | both pre-existing BUGS rows (object-literal shape; env-graph orphan placement) |
| 5 | `diff:CreateEnvironment/LoadConst` 121 | `diff:GetById(reg)` 316 | react-navigation's is the **new** register-reuse bucket family (BUGS row above) — the real residual gap this normalisation does not close |

## 2026-09-01 (commit: see git log for this file) — macOS arm64, 10 cores, hermesc from `tools/hermesc/vNN`

| bundle | HBC | mode | modules | functions measured / in bundle | IDENTICAL | DIFFERENT | RECOMPILE-ERROR | DECOMPILE-STUB | wall |
|---|---|---|---|---|---|---|---|---|---|
| rn-template-0.72 (committed) | v94 | passes-off | 435/435 | 4125 / 4199 | **20.58%** (849) | 3276 | 0 | 0 | 11 s |
| rn-template-0.72 (committed) | v94 | passes-on | 435/435 | 4125 / 4199 | **37.28%** (1538) | 2587 | 0 | 0 | 16 s |
| react-navigation-example-0.85.3 (committed, fetch.sh) | v98 | passes-off | 1782/1782 | 14437 / 15551 | **25.30%** (3653) | 10784 | 0 | 0 | 7 s |
| react-navigation-example-0.85.3 (committed, fetch.sh) | v98 | passes-on | 1782/1782 | 14437 / 15551 | **29.52%** (4262) | 10175 | 0 | 0 | 92 s |
| expensify-app-0.86.0 (committed, fetch.sh) | v98 | — | not present locally (fetch.sh needs a full Expensify clone + build) | | | | | | |
| Service NSW (local, proprietary) | v96 | passes-off | 4510/4510 | 43302 / 43384 | **15.56%** (6738) | 36564 | 0 | 0 | 36 s |
| Service NSW (local, proprietary) | v96 | passes-on | 4510/4510 | 43302 / 43384 | **29.05%** (12580) | 30722 | 0 | 0 | 722 s (715 s is the passes-on split — the superlinear term of BUGS row 2026-09-01) |
| Discord / MetaMask / Brex (local corpus, 190k / 109k / 120k fns) | v98 / v96 / v98 | passes-off | not measured yet: the first attempt OOMed in the main thread's split at Node's default 4 GB heap — rerun: `node --max-old-space-size=24000 tools/e2e/roundtrip-corpus.ts --only local-com.discord,local-io.metamask,local-com.brex.mobile --passes off --jobs 3 --out <scratch>` (one bundle at a time is safer) | | | | | | |

"functions measured" = every function reachable from a Metro module's
factory; the remainder is the global function and the Metro prelude, which
the split does not emit. Wall = split + recompile/compare, `--jobs` 3–5.
`RECOMPILE-ERROR 0` everywhere: **every module file of every bundle
recompiles with its hermesc** (v98 needed the recompiled file parsed with
the bundle's layout forced — a one-module file is too small for the layout
probe, `E_LAYOUT_AMBIGUOUS`). `DECOMPILE-STUB 0`: no function hit
`emitModule`'s isolation stub on any of these bundles.

### Top buckets (passes on unless noted; each bucket has a docs/BUGS.md row dated 2026-09-01 "E2E tier 1")

| bucket | rn-template | react-navigation | Service NSW (off) | what it is |
|---|---|---|---|---|
| `diff:TryGetById(string)` | 284 | 1309 | 1882 (2529 on) | dead `rN = globalThis` residue after global-access |
| `tree:unmatched-closure(orig 1 vs recompiled 0)` | 38 | 688 | — | nested function declared in no split file (react-navigation) / closure stored to a never-read register, dropped by `-O` (rn-template) |
| `diff:LoadFromEnvironment(imm)` + `diff:CreateFunctionEnvironment(imm)` | — | 586 + 568 | — | captured variables declared in a different slot order (v98) |
| `diff:PutNewOwnById/PutById`, `diff:PutOwnBySlotIdx/PutByIdStrict` | 153 | 248 | 1114 (2377 on) | object literal emitted as `{}` + assignments |
| `diff:GetById/LoadConstNull`, `diff:GetEnvironment/LoadConstNull` | 170 + 41 | — | 1511 + 975 | `LoadThisNS` printed as the explicit `this` coercion in sloppy functions |
| `diff:CreateEnvironment/LoadConstUndefined`, `…/LoadParam` | 78 + 103 | — | 856 | `let r0, r1, …` prologue survives `-O` as N × `LoadConstUndefined` |
| `diff:LoadParam(imm)` | 116 | — | 2681 | factories: the split's `require(dependencyMap[i])` → `require('./module_N.js')` rewrite changes which parameters are read first — **by design of the split**, not a decompiler bug |
| `diff:LoadConstUndefined/GetGlobalObject` (passes off only) | 440 | 265 | 4634 | the M4 `Reflect.apply(...)` call shape; gone with `call-shape` on |
| `diff:GetByVal(reg)`, `diff:GetById(reg)` | 100 | 328 | 4370 + 1312 | register reuse differs (the normalisation's known limit: same sequence, different allocation) |
| `diff:GetOwnPrivateBySym/GetByVal` | — | 151 | — | v98 private fields emitted as computed access |
| `diff:StartGenerator/CreateEnvironment` | — | — | 856 | generators via `__hbc_makeGenerator` (D9) — never IDENTICAL by construction |
| `diff:param-count` | 0 | 293 | — | harness pairing limit with passes on (same-named siblings) |

### Reading the numbers

- The passes-on number is the honest one: with passes off, every call is
  the M4 `Reflect.apply` shape and cannot round-trip. rn-template's 37%
  is the first real-app bytecode-level round-trip figure this project has.
- The buckets are dominated by *shape* choices, not wrong code: dead
  `globalThis` loads, object literals, the register prologue, `this`
  coercion. The one correctness finding is react-navigation's
  never-declared nested functions (BUGS row: `src/split`).
- The passes-on split of react-navigation costs 88 s against 3 s with
  passes off (P-1's ≈7× is ≈30× here); Service NSW's passes-on split is
  the same superlinear term as the whole-file 452 s (BUGS row 2026-09-01):
  715 s for 43k functions, then 6.7 s to recompile and compare all 4,510
  modules. Passes on lifts NSW from 15.56% to 29.05%.
