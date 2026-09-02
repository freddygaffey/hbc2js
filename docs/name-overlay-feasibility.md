# Naming overlay (Design D) — feasibility sanity-check

Verdict: **FEASIBLE, no blocker.** Both risks the overseer flagged clear
against the code. v1 = register locals only (env slots / function names
deferred — see below). Implementation proceeds.

## Risk (a) — is `fnIndex` threaded to the emit/render path?
**Yes.** The Hermes bytecode function index is the loop variable of
`emitModule`'s `emitOne(index)` (`src/emit/index.ts`), and every downstream
hook receives it as `cfg.functionIndex` (`FunctionCfg.functionIndex`,
`src/cfg/types.ts:117`). The stage-B AST hook `astPasses(fn, cfg)` — the render
point where a register ident is still `rN` — is called per function with that
`cfg` in hand, and `astPassHook` already exposes an `onResult(functionIndex,
…)` tap keyed on exactly `cfg.functionIndex` (`src/passes/index.ts`). So the
binding id `{fn: cfg.functionIndex, reg: N}` is derivable, stable across
re-decompiles (it is the binary's own function-table index, not emitted text),
and addressable at the one render point. No plumbing change needed.

## Risk (b) — can render inject an EXTERNAL name into var-naming's slot cheaply?
**Yes**, and it is literally "the same slot var-naming already fills". A
register name lives as an `ident{name:"rN"}` in the frame plus an entry in the
frame's leading `let r0, …` decl. `var-naming` fills that slot by
`renameRegistersInFrame(body, {rN → newName})` (`src/passes/var-naming/
rewrite.ts`) — a frame-local, func-boundary-stopping pure alpha-rename.

The overlay reuses that exact function, applied to the **raw `rN` body BEFORE**
the var-naming astPass runs (render wraps `astPasses`: apply overlay renames,
then delegate to the normal hook). Consequences, all favourable:
- `var-naming`'s `classifyAll` filters candidates by `isRegisterName`, so an
  overlaid name (`userInput`) is invisible to it — it never re-touches or
  fights the external name.
- `var-naming`'s `taken` set = `freeNames ∪ declaredNames` of the frame, which
  now includes the overlaid name (it is in the decl), so heuristic names for
  *other* registers cannot collide with it.
- Every applied rename remains a guarded, frame-local pure alpha-rename →
  behaviour cannot change (same invariant as `07-var-naming.md` §1). The
  trace-oracle is the backstop.

### The reuse gate
Reused via `classifySite(fnBody, "rN")` (`src/passes/var-naming/match.ts`),
evaluated at `setName` time (the CLI builds the analysis once). An external
name is **refused** when the register's verdict is `reuse-conflict` (defs span
more than one role — the spec's "uses span more than one role") or
`globalthis-alias` (naming a `globalThis` alias would mislead). The heuristic-
supply reasons (`no-heuristic`, `pool-exhausted`, `dedup-exhausted`) are *not*
refusals for an external name — supplying the name the heuristic could not
invent is the whole point. `--override` forces past `reuse-conflict`/
`globalthis-alias`, stamping `gate:"overridden"` + forced `confidence:"low"`.
Name *validity* (reserved word / emitter-name-class / unsafe ident) is refused
unconditionally — an override cannot emit invalid JS.

## v1 scope (registers only) — confirmed, with deferrals noted
- **Register locals `{fn,reg}`** — fully implemented here.
- **Environment slots `{fn,env}`** — DEFERRED. Their identity is owned by
  `closure-naming`'s slot model (spec §8), which **is not built yet**. The
  store's record shape leaves room (a `kind` discriminant), but v1 refuses env
  ids so no unsound name is ever applied to a slot the model can't address.
- **Function names `{fn}`** — DEFERRED to v1.1. `fn-naming` exists, but keying
  its recovered names into the overlay is out of the register-locals critical
  path; noted, not built.
</content>
