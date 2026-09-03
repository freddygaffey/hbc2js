# Parallelising the decompile pipeline — part 1: worker pool (design note)

docs/QUEUE.md "PARALLELISE THE DECOMPILE PIPELINE — function-level". Evidence
(M5, 12M NSW, 43k fns): whole readable decompile (structure + D12 passes) =
662s single-threaded vs `--split` (structure, no D12 passes, no verify) = 12s
for the same function count. The **stage-A pass pipeline** (`src/passes`'
matcher/rewriter rungs, applied per function to the structurer's tree IR
before `emitFunction`) is the 55x-dominant serial cost, and per
`src/emit/index.ts`'s `emitOne` it is a pure function of one function's own
`StructuredFunction` + its own `FunctionCfg` — nothing else. That is this
part's parallelisation target; parts 2–3 (body-hash cache, scoped
single-function decompile) are separate work.

## What actually depends on what

`emitOne(index)` in `src/emit/index.ts` does, per function, in order:
1. `cfg = analysis.cfg(index)` — cheap, derived from the shared parsed
   module, read-only.
2. `structured = structure(cfg)` — cheap (part of the 12s `--split`
   baseline). Its `.graph` (`AugmentedCfg`) carries a `dominates(a, b)`
   **closure**, so it is *not* structured-clone-safe across a
   `worker_threads` boundary.
3. `structured = opts.passes(structured, cfg)` — **the expensive step**
   (stage-A, `src/passes/index.ts` `runPasses`). Reads only `structured`,
   `cfg`, the read-only `analysis`/`moduleView` (both derivable from the same
   bytes). Provably independent per function (QUEUE evidence + `runPasses`'
   own signature — no other function's state enters).
4. Recurse into children (closure nesting) — **this is genuinely a
   bottom-up tree dependency**: a parent's `emitFunction` call splices its
   children's *already-assembled* JS `Stmt` bodies in directly, so the
   assembly walk cannot be flattened without restructuring `emitFunction`
   itself.
5. `emitFunction(...)` — cheap (part of the 12s baseline), needs children's
   assembled bodies (step 4).
6. `opts.astPasses(out, cfg)` — stage-B, runs on the **already-assembled**
   AST including spliced children, so unlike stage-A it cannot be computed
   for a function independently of its children without a bigger rewrite.
   Not touched by part 1.

## Design

Parallelise step 3 only (the proven 55x-dominant, proven-independent cost).
Steps 1, 2, 4, 5, 6 and every module-level pass (closure graph, `parentOf`/
`childrenOf`, `loopLocal`, `checkBindings`, `printProgram`, the helper
prelude) stay exactly as today, serial, on the main thread — unmodified.

- **Shared state**: none, by construction. Each worker independently
  `parseHbc`s the same bytes and `analyseModule`s them (this repeats the
  cheap ~12s-class work N-workers times, not the 662s-class work — the
  trade is deliberate and cheap at typical worker counts). No object is
  shared or mutated across threads; only plain data crosses the
  `postMessage` boundary (function index, per-function options — all
  JSON-serialisable per `AnalysisOptions`/`StructureOptions`/
  `PassPipelineOptions`).
- **What crosses the boundary**: from worker to main, only the fields a
  stage-A pass can change — `root` (the rewritten `Stmt` tree), `labels`,
  `dispatchVars`, `duplicatedBlocks`, `stats`, `diagnostics`. Never `.graph`
  (the `dominates` closure). The main thread computes its own
  `structure(cfg)` regardless (step 2, cheap, needed anyway for `.graph`),
  then splices in the worker's stage-A fields — `runPasses` never touches
  `.graph`, `.functionIndex` or `.graph`-derived identity, only the tree and
  the pass-derived metadata, so this splice is exact, not approximate.
- **Determinism / byte-identity**: the assembly walk (steps 1,2,4,5,6) is
  bit-for-bit the existing serial code, driven off a lookup table instead of
  an inline call — so output order is fixed by `emitOne`'s existing
  recursion (closure-nesting order), never by worker completion order.
  Function index assignment to workers (round-robin) and completion order
  are irrelevant to the result: each function's stage-A result is looked up
  by index, not appended in arrival order. `workers=1` takes the exact
  serial path (`decompile()` unchanged, no `Worker` spawned) — the gate test
  below proves `workers=4` matches it byte-for-byte.
- **Default worker count**: `max(1, cpus - 2)`, overridable via
  `HBC2JS_WORKERS` (env, `1` forces the exact serial path — no pool spawned
  even when explicitly requested through the parallel entry point). The
  `-2` leaves headroom for a fuzz campaign or the OS on the same box, per
  the brief.
- **Failure semantics**: a worker `error` event or non-zero `exit` fails the
  whole `decompileParallel()` call (`Promise.reject`) — the pool is torn
  down (`worker.terminate()` on every other worker) and no partial/silent
  result is returned. This mirrors `emitModule`'s own module-level refusals
  (`E_ENV_UNRESOLVED`); a stage-A crash is not per-function-isolated the way
  `E_EMIT_UNSUPPORTED` is (that isolation is a *policy* choice made once, on
  the main thread, by `emitOne`'s catch — the worker pool does not
  re-implement it, so a worker-side bug surfaces loudly instead of being
  silently swallowed twice).

## Soundness argument

Per-function stage-A passes are independent by construction of
`runPasses(analysis, fn, cfg, opts, moduleView)`: `fn`/`cfg` are this
function's own data, `analysis`/`moduleView` are read-only and identical
across every function and every worker (same bytes, same options — the
`opcodeTable` a worker uses is the exact table `parseForDecompile` already
resolved on the main thread, passed explicitly, so no worker re-runs the
v98 ambiguity heuristic and could disagree with the main thread's choice).
Nothing cross-function (closure graph, `parentOf`/`childrenOf`, `loopLocal`,
env-slot ownership) is touched inside `runPasses` — those all live in
`emitModule`, on the main thread, untouched by this change.

## Measured (rn-template-0.72, 4199 functions, this machine, best-of-2)

| run | wall time |
|---|---|
| `decompile()` serial | 6.3s |
| `decompileParallel(bytes, opts, 4)` | 6.7s (no win — see below) |
| `structure()` + stage-A alone (all 4199 fns, single thread) | 0.67s |
| `structure()` + stage-A via the pool (4 workers) | 0.69s wall |
| full decompile with `passes: { none: true }` (skips *both* stages) | 0.67s |

Honest finding, not the hoped-for result: **on rn-template, stage-A (the
piece this part parallelises) is cheap — only ~0.67s of the 6.3s total.**
The other ~5.6s is stage-B (`astPasses`) + `emitFunction`, which this part
deliberately leaves serial (§"What actually depends on what" — stage-B
operates on the already-assembled tree, spliced children included, so it
cannot be split by function without also decoupling `emitFunction`'s own
per-function statement construction from its child-splicing, a materially
bigger change than a worker pool). Parallelising stage-A therefore buys
rn-template ~0s, and the pool's fixed overhead (per-worker `parseHbc`+
`analyseModule`, worker startup, `postMessage` structured-clone of every
function's `root` tree) makes the end-to-end number a wash-to-slightly-worse
here.

This does not contradict the QUEUE evidence (662s single-threaded vs 12s
`--split`, 43k fns, 12M-line NSW) — that bundle is ~10x more functions with
apparently much heavier per-function pass-matcher hits (55x split cost there
vs the ~1x seen on rn-template's 4199 simpler/smaller functions), so
stage-A's share of total cost is plausibly nonlinear in function
size/complexity in a way rn-template doesn't exercise. This part's pool is
correct and does what the design promises (byte-identical, near-linear on
the piece it parallelises — 0.67s serial vs 0.69s wall on 4 workers is
consistent with the fixed per-worker parse/analyse floor dominating at this
scale, not with the parallelisation itself failing), but **the measured win
on the one real bundle available in this repo is ~0**. Re-measuring on a
bigger/heavier bundle (proprietary `local-corpus/`, not available in this
sandboxed run) or building a synthetic heavy fixture would confirm whether
stage-A is the right target at the scale the QUEUE evidence was taken from;
absent that, the honest caveat is: **this part's payoff is
bundle-dependent, and stage-B (`astPasses`) is the next thing to look at if
rn-template's profile turns out to be the more common case, not just NSW's
outlier scale.**

## What is NOT part 1

- The per-function body-hash result cache (part 2).
- Scoped single-function decompile (part 3).
- Parallelising `structure()`, `emitFunction()` or stage-B `astPasses` —
  cheap or tree-coupled respectively; not the proven bottleneck.
- CLI `--workers` flag — `decompileParallel()` is a new async export
  (`decompile()` stays synchronous and untouched); wiring a CLI flag is
  follow-up, not required for the correctness/perf claims here.
