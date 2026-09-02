# Rename tool — Design D (naming overlay over the binary, 2026-09-02)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/var-naming/` (index, frame,
match, check, rewrite), `docs/specs/passes/07-var-naming.md`, this file. Depends
on the existing frame/register binding model and the stage-B reuse gate.

> **Supersedes Design C's Layer 1.** C proposed a `ts-morph` rename over emitted
> `.js`. D replaces that engine: the rename is a **non-destructive naming overlay
> keyed to the binary's own binding identities**, and emitted JS is a *rendered
> view* of binary-plus-overlay. C's Layer 2 (naming discipline, confidence,
> evidence) is retained and re-expressed here as records in the overlay. `ts-morph`
> survives only as a fallback (§12). Nothing is built yet.

## 1. Purpose & context
Fred is building an LLM-driven vulnerability-analysis loop over hbc2js output. In
that loop an LLM reads decompiled JavaScript full of `rN` registers and wants to
assign meaningful names so it can reason about the code. It needs to do this
**many times, cheaply, safely, reversibly, and searchably**.
The goals are ordered. **Truth first**: a name never changes behaviour, and a
wrong name is refused in favour of a plain `rN` (§6) — faithfulness is never
traded for anything below. **Efficient to use second, a primary design goal**:
because the caller is an LLM, the tool must be cheap to INTERACT with — minimal
token/context overhead per operation, scoped input, compact output, the resident
service so a batch of names needs no re-parse. This is NOT about rationing total
tokens (spending tokens to name well is fine); it is about not WASTING them —
naming or verifying one register should not cost a whole-function render.
Pursued within truth and without dropping valuable features: a tool that lowers
interaction cost by emitting a less-true view is broken, which is worse.

The insight that shapes D: a name is not a text edit to a `.js` file. It is an
**annotation on a binary-derived binding**. hbc2js already models that binding —
`var-naming` treats a register as scoped to exactly one function frame
(`frame.ts`: a register in a nested `func` is "a different frame's own local that
happens to share a number"). D makes that binding **addressable, nameable,
versioned, and queryable**, and renders names at emit time. Pure alpha-renaming
within one frame: no statement moves, no expression changes shape, no value is
computed differently (same invariant as `07-var-naming.md` §1).

## 2. Relationship to existing code (do not rebuild what exists)
- **`var-naming` (stage B)** already invents a register name from usage and
  **already refuses a name it cannot justify** via the reuse gate ("a wrong name
  is worse than a plain `rN`"). D does not replace this. D adds an *external
  source of names* (an LLM, or a human) that feeds **the same slot**, through the
  same gate.
- **`fn-naming` / `closure-naming`** own function names and `-g` environment
  slots respectively. D's overlay must key those too (§8), reusing their models
  rather than inventing a parallel one.
- **Emitter (`src/emit`)** is where the overlay is applied to produce named
  output — the one render point.

## 3. Binding identity — the canonical key (the crux)
Every nameable binding gets a stable, serializable id derived from the compiled
binary, so it is identical across decompiler runs and independent of emitted text:

| binding kind | id | source |
|---|---|---|
| register local | `{ fn: <fnIndex>, reg: <n> }` | bytecode function index + register number |
| environment slot | `{ fn: <definingFnIndex>, env: <slot> }` | closure-naming's slot model |
| function | `{ fn: <fnIndex> }` | bytecode function index |

`fnIndex` is the Hermes function's index in the bundle — binary-derived and
stable. This is why the tool is, in Fred's words, "an extension on the compiled
binary": the key comes from the binary, not from the rendered `.js`. An LLM cites
`{fn,reg}`, never `(file, line, oldName)`, so a name never breaks when another
name lands.

## 4. The overlay store
A versioned sidecar (one per analysed bundle), the single source of truth for
names. It is never the emitted `.js`.

Record (one per assigned name):
```json
{ "id": {"fn": 42, "reg": 7}, "name": "userInput", "confidence": "med",
  "evidence": "flows from JSON.parse(response) into a taint sink",
  "source": "llm|heuristic|human", "gate": "passed|overridden",
  "ts": "<iso>", "supersedes": "<prior record id|null>" }
```
- **Append-only history:** a new name for the same binding does not overwrite; it
  supersedes, so the full timeline is retained.
- **Revert** = re-activate a superseded record (or clear to `rN`). Nothing is
  destroyed.
- **Searchable:** the store is queried, not grepped — "all low-confidence names",
  "the current name of `{fn:42,reg:7}`", "what was this binding before".

## 5. Interface
Addressable naming API (primary — the loop imports this; no text parsing):
```ts
setName(id: BindingId, name: string, meta: NameMeta): SetResult   // upsert + history
getName(id: BindingId): NameRecord | null
revert(id: BindingId, toTs?: string): void                        // rollback
search(query: NameQuery): NameRecord[]                            // by confidence/source/text/fn
render(fn?: number): string                                       // emit named JS (view)
```
CLI (thin wrapper, one-offs and tests):
```
hbc2js name set  <fn> <reg> <newName> [--conf low|med|high] [--evidence <s>] [--override] [--json]
hbc2js name get  <fn> <reg>
hbc2js name revert <fn> <reg> [--to <ts>]
hbc2js name search [--conf low] [--source llm] [--fn 42] [--text foo]
hbc2js render [--fn 42] [--out <dir>]
```
Resident service mode is the primary form for the loop: the program stays warm,
the overlay stays loaded, successive `setName` calls need no re-parse (carries
C §1.7 forward). In-memory operation: names live in the store, the binary is
read once; no `.js` round-trip per call.

## 6. Naming discipline & the reuse gate (fork 1 resolved)
- An externally supplied name **passes through the existing reuse gate** by
  default. If the gate would refuse (uses span more than one role), the name is
  refused with the gate's reason. This keeps the project's best safety rail.
- `--override` (or `gate:"overridden"` via API) forces a refused name, but the
  record is stamped `gate:"overridden"` and **forced to `confidence:"low"`**, so
  every override is visible and searchable. An override is a deliberate, recorded
  act, never silent.
- Naming rules carried from Design C Layer 2: no name without evidence; neutral
  when evidence is weak (`serverResponse`, not `validatedLicence`, unless proven);
  JS conventions; specific not verbose. Evidence and confidence are mandatory
  fields, not optional.

## 7. Rendering & behaviour preservation
- Names are applied only at render, as pure alpha-renaming within a frame. The
  binary and the structured decompile are untouched, so behaviour cannot change
  by construction — there is no text rewrite to get wrong.
- Collision at render: two bindings in one frame resolving to the same name →
  the render disambiguates deterministically (suffix) and flags it in the store,
  rather than emitting shadowed names.
- Property keys, string-keyed members, and dynamic accesses are **never** named
  (they are contract, not bindings) — same hard rule as A/C.

## 8. Scope: registers, env slots, functions (fork 3 resolved)
- **Register locals** (`{fn,reg}`) are the primary target and are fully owned here.
- **Environment slots** (`{fn,env}`) cross frames; their identity comes from
  `closure-naming`'s slot model, not a parallel one. D stores names for them but
  defers slot *identity* to that model (mirrors `07-var-naming.md`'s split, which
  leaves `_eN_M` to closure-naming).
- **Function names** (`{fn}`) reuse `fn-naming`'s recovered names as the initial
  record; the overlay lets them be renamed and tracked like any other binding.

## 9. History / revert / search operations
- `history(id)` → the full superseding chain for a binding.
- `revert(id, toTs?)` → re-activate a prior record or clear to `rN`.
- `diff(tsA, tsB)` → names that changed between two points (for review).
- `search` filters: confidence, source (`llm|heuristic|human`), gate status,
  `fn`, free-text on name/evidence. This is the audit trail a security review
  needs — e.g. "list every `overridden`, low-confidence name touching fn 42".

## 10. Output (token-minimal — hard requirement, from A)
`setName` success, one line: `named {42,7} → userInput [med, gate:passed]`
`--json`: the full record (§4). No diff, no file dumps; the caller renders when
it wants a view. `render` is the only command that emits code.

## 11. Acceptance tests (ship with the spec, before implementation)
1. **Identity stability:** re-decompiling the same bundle yields identical
   `{fn,reg}` ids; a name set before still resolves after.
2. **Gate honoured:** a name for a multi-role register is refused; `--override`
   applies it stamped `overridden` + `low`.
3. **Behaviour preservation:** render before/after a batch of names → structural
   equivalence (identifiers only) + execute-and-compare on runnable fixtures.
4. **Frame isolation:** naming `{fn:A,reg:7}` never affects `{fn:B,reg:7}`.
5. **History + revert:** a second name supersedes without loss; `revert` restores
   the prior name and, with no prior, clears to `rN`.
6. **Search:** confidence/source/fn/text filters return exactly the matching
   records; empty result is empty, never an error.
7. **Collision at render:** two names colliding in one frame disambiguate
   deterministically and are flagged.
8. **Property/string never named:** a `{fn,reg}` that resolves to a property
   access is refused, not silently applied.
9. **Determinism harness:** LLM mocked via fixtures; no network in tests.
10. **Token-minimal output:** exactly the one-line / JSON shapes.

## 12. Non-goals (v1) & fallback
- **`ts-morph` fallback only:** used solely when a rename target has no binding id
  the overlay can address (rare; e.g. hand-edited emitted text). Not the engine.
- No renaming of properties, string-keyed members, dynamic accesses.
- No writing names back into the `.hbc` binary itself (the overlay is external).
- No semantic name *invention* beyond what `var-naming` already does — D is the
  addressable/tracked/LLM-fed layer, not a new heuristic namer.
- Type inference; multi-user concurrent editing of one store.

## 13. Decisions resolved vs the earlier designs
- **Overlay, not text refactor** (supersedes C Layer 1). Binding id from the
  binary; emitted JS is a view.
- **Fork 1 — LLM names pass the reuse gate;** override is recorded, low-confidence.
- **Fork 2 — sidecar overlay store** (versioned, portable), not pipeline-only
  state, so history/revert/search are first-class.
- **Fork 3 — env slots keyed via closure-naming's model;** registers owned here.
- Retained from A: token-minimal output, resident service, collision-refuse
  posture (here: refuse-or-disambiguate at render), properties-never.
- Retained from B/C: evidence + confidence discipline, the audit trail, mocked-LLM
  determinism.
