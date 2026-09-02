# Naming overlay (Design D) — usage

A non-destructive layer of names over a decompiled bundle, for the LLM
vulnerability-analysis loop: assign meaningful names to `rN` registers many
times, cheaply, safely, reversibly, searchably. A name is an annotation on a
binary-derived binding, not a text edit; the emitted JS is a *rendered view* of
binary-plus-overlay. Spec: `docs/specs/rename-tool-DESIGN-D-overlay.md`.
Feasibility / design rationale: `docs/name-overlay-feasibility.md`.

## What a name is keyed to

Every nameable binding has a stable id derived from the compiled binary, so it
survives re-decompilation and is independent of emitted text. v1 owns register
locals: `{ fn: <bytecode function index>, reg: <register number> }`. Env slots
(`{fn,env}`) and function names (`{fn}`) are reserved in the id shape but
deferred to `closure-naming` / `fn-naming` (spec §8) and are refused for now.

## The store

A versioned JSON sidecar, one per bundle — by default `<input.hbc>.names.json`,
or `--store <path>`. Append-only: a new name for a binding *supersedes* the old
one (the timeline is kept); `revert` re-activates a prior record, or clears back
to `rN` when there is none. It is never the emitted `.js`.

Each record: `{ id, name, confidence, evidence, source, gate, ts, supersedes }`
(plus a store-local `rid` and an `active` flag). Evidence and confidence are
mandatory; a name without evidence is discipline debt.

## The reuse gate

An externally supplied name passes through var-naming's existing reuse gate. It
is **refused** when the register's uses span more than one role
(`reuse-conflict`) or it aliases `globalThis` (`globalthis-alias`) — a wrong
name is worse than a plain `rN`. `--override` forces past those, but the record
is stamped `gate:"overridden"` and forced to `confidence:"low"`, so every
override is visible and searchable. A reserved word, an emitter-shaped name
(`r5`, `_fn0`, …), or a register that is not a live binding in its frame (e.g. a
property/string key — never a binding) is refused **unconditionally**: an
override can never emit invalid JS or name a non-binding.

## Rendering

`render` applies the active names at emit time, as a pure frame-local
alpha-rename (the same `renameRegistersInFrame` var-naming uses), keyed on the
raw `rN` *before* var-naming runs — so the external name fills the very slot the
heuristic would have, and un-named registers still get their heuristic name.
Behaviour cannot change by construction (no text rewrite); the trace-oracle is
the backstop (0-DIVERGENT). Two names colliding in one frame are disambiguated
with a deterministic suffix (`dup`, `dup_2`) and the collision is flagged back
into the store.

## CLI

```
hbc2js name set  <fn> <reg> <newName> --hbc <in.hbc> [--conf low|med|high] \
                 [--evidence <s>] [--source llm|heuristic|human] [--override] [--json]
hbc2js name get    <fn> <reg> [--store <path>|--hbc <in.hbc>] [--json]
hbc2js name revert <fn> <reg> [--to <ts>] [--store <path>]
hbc2js name search [--conf low] [--source llm] [--gate overridden] [--fn 42] [--text foo] [--json]
hbc2js render --hbc <in.hbc> [--fn N] [--store <path>] [--out <file>]
```

`name set` needs `--hbc` (to run the gate); `get`/`revert`/`search` are
store-only and take `--store` (or `--hbc`, from which the default store path is
derived). Output is token-minimal (spec §10):

```
$ hbc2js name set 0 9 loopLimit --hbc app.hbc --conf med --evidence "loop bound 10" --source llm
named {0,9} → loopLimit [med, gate:passed]

$ hbc2js name set 0 6 g --hbc app.hbc
refused {0,6} g [globalthis-alias] (use --override to force)      # exit 3

$ hbc2js name set 0 6 g --hbc app.hbc --override
named {0,6} → g [low, gate:overridden]
```

`--json` on `set`/`get`/`search` emits the full record(s) instead.

## Programmatic (resident) API — the loop's primary form

```ts
import { NameService, OverlayStore, regId } from "./src/name-overlay/index.ts";

const svc = new NameService(analysis, OverlayStore.load(storePath, bundle));
svc.setName(regId(42, 7), "userInput", { confidence: "med", evidence: "…", source: "llm" });
svc.getName(regId(42, 7));       // NameRecord | null
svc.history(regId(42, 7));       // full supersession chain, newest first
svc.revert(regId(42, 7));        // rollback; returns now-active record or null (rN)
svc.search({ gate: "overridden", fn: 42 });
svc.render({ fn: 42 });          // { code, collisions }
```

The bytecode is parsed once; the raw frame bodies and overlay stay warm, so
successive `setName` calls run the gate with no re-parse and no `.js` round-trip
(spec §5). No network is used anywhere; an LLM is just a `source` label.

## v1 non-goals

Env slots and function names (deferred, spec §8); property / string-key /
dynamic-access renaming (never — they are contract, not bindings); writing names
into the `.hbc`; new heuristic name *invention* (that is var-naming's job — this
is the addressable, tracked, external-fed layer over it).
