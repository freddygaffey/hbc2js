# 10 — The decompile artifact: rendered tree + queryable index (P2.1 + P2.1a)

**Status: SPEC (2026-09-03, Fable). Gates all of Stage 2.** Every downstream
tool — project store (P2.2), string/secrets indexer (P2.3), version diff
(P2.5), Frida gen (P2.6), the LLM bug-finding loop (P2.7) — consumes THIS
artifact, never hbc2js internals. If a Stage-2 tool imports from `src/parse`,
`src/cfg` or `src/emit` directly, that is a spec violation to be pushed back on.

**Stage-2 success criteria apply IN ORDER (docs/QUEUE.md Stage 2): (1) TRUTH,
then (2) EFFICIENT TO USE.** Concretely for this spec: an index edge is never
guessed (unknowns are marked `?` with a reason); a stale index is a hard error,
never a silently wrong answer; and only then is every query given a hard output
bound so the loop spends its context on findings, not on re-derivation.

Builds on `docs/specs/rename-tool-DESIGN-D-overlay.md` (Design D): the
`{fn,reg}` / `{fn,env}` / `{fn}` binding ids and their canonical string forms
(`src/name-overlay/id.ts` `bindingKey`) are the *only* keys this format uses.
That is the point of binding ids — they come from the binary, so they survive
every rename and every re-render.

Self-contained for consumers: a Stage-2 tool needs this document and the files
in §2–§3, nothing else. Implementers additionally read §8.

## 0. Where this sits in the pipeline

```
bytecode ──decompile──► AST per function (src/emit + src/passes)
     │                         │
     │                         ├──► RENDER: source tree (src/split → segregate, existing)
     │                         │        module_<id>.js / src/… / node_modules/…
     │                         │        (names applied from the Design-D overlay at render)
     │                         │
     │                         └──► INDEX BUILD (NEW, this spec): index/*.jsonl
     │                                  semantic layer: calls, strings, globals,
     │                                  native, modules, functions
     │                                  presentation layer: ranges (per render)
     │
     └────────────────────────────► manifest.json (hashes tie all three together)
```

Two layers, deliberately split:

- **Semantic layer** — derived from the bytecode + decompiled AST, keyed to
  `fnIndex`/binding ids, **independent of the render**. A rename (Design-D
  overlay) does not invalidate it. Rebuilt only when the decompile itself
  changes (new bundle bytes, new hbc2js version, new pass configuration).
- **Presentation layer** — `ranges.jsonl`, mapping ids to `file:line` of the
  *current* render. Regenerated on **every** render (it is cheap: the renderer
  already walks everything it prints). This is the only render-coupled file.

This split is the answer to "how do renders stay consistent with the index
across re-renders": they don't have to — the semantic index never referenced
the text in the first place.

## 1. Artifact layout on disk

One directory per analysed bundle (the future P2.2 project store grows around
this same directory; the naming overlay sidecar already lives beside it):

```
<artifact>/
  manifest.json            # §1.2 — versions, hashes, provenance; the root of trust
  src/…                    # rendered tree (segregated form, spec 08) …
  node_modules/…           # …
  module_<id>.js × N       # … or the flat --split form; either way MODULES.json is present
  MODULES.json             # existing split/segregate output (spec 08)
  index/
    functions.jsonl        # §2.1  one row per fnIndex
    calls.jsonl            # §2.2  call-graph edges
    strings.json           # §2.3a string table (sid → value)
    string-uses.jsonl      # §2.3b sid → use sites
    globals.jsonl          # §2.4  global read/write/call sites
    native.jsonl           # §2.5  builtin + host/module-boundary surface
    modules.json           # §2.6  module graph (id, deps, entry, fn ownership)
    ranges.jsonl           # §2.7  id → file:line of the CURRENT render (presentation layer)
  overlay/
    names.jsonl            # Design-D overlay store (owned by spec D, referenced here)
```

### 1.1 File format rules

- Index files are **JSONL** (one self-contained JSON object per line): grep-able
  by any tool with zero parsing setup, streamable, and a query never has to load
  a file it only needs ten lines of. Small whole-graph files (`manifest.json`,
  `modules.json`, `strings.json`) are plain JSON.
- Every row that refers to a binding uses the canonical key strings from
  `src/name-overlay/id.ts` (`fn:42`, `fn:42/reg:7`, `fn:42/env:3` — whatever
  `bindingKey` emits; the implementer uses that function, not a reimplementation).
  Function references that are not bindings use the bare integer `fnIndex`.
- Rows are sorted by primary key (fnIndex, then site order) so diffs between two
  artifact versions (P2.5) are line diffs.
- Schema version: every index file's **first line** is a header object
  `{"schema":"hbc2js-index/1","kind":"calls","renderIndependent":true}`.
  A consumer that sees an unknown major schema must refuse, not guess.

### 1.2 `manifest.json`

```json
{
  "schema": "hbc2js-artifact/1",
  "bundle": { "sha256": "…", "bytes": 1234567, "hbcVersion": 96, "functionCount": 4321 },
  "producer": { "hbc2js": "<package version>", "git": "<commit hash or null>",
                "passes": { "…the exact PassPipelineOptions used…" },
                "strictEnv": true },
  "render": { "hash": "<sha256 over every rendered file, sorted-path order>",
              "form": "segregated|flat", "ts": "<iso>",
              "overlayHash": "<sha256 of overlay/names.jsonl at render time, or null>" },
  "index": { "semanticHash": "<sha256 over the semantic-layer files>",
             "builtFor": { "bundleSha256": "…", "producer": "…" } }
}
```

Rules:

- `render.hash` is recomputed on every render; `ranges.jsonl`'s header carries
  the `render.hash` it was generated against. **Mismatch = `E_STALE_INDEX`,
  a hard error** (§4.2).
- `index.builtFor` ties the semantic layer to bundle bytes + producer config.
  If either differs from the current decompile, the semantic layer is stale —
  same hard error. There is no "probably still fine" state.
- Provenance is mandatory: an artifact with no manifest is not an artifact,
  and no tool may fall back to reading the render without one.

### 1.3 Re-decompile / incremental story (v1 = deliberately simple)

- **Re-render** (names changed, same decompile): rewrite the changed source
  files, regenerate `ranges.jsonl` in full, bump `render.hash`/`overlayHash`.
  Full `ranges` regeneration is O(render) and the render is already O(render);
  no partial-update machinery in v1. Semantic layer untouched.
- **Re-decompile** (new bundle bytes or new producer config): a NEW artifact
  directory (or full overwrite) — the semantic layer is rebuilt from scratch.
  No incremental semantic update in v1: correctness of a merge is exactly the
  kind of subtle wrongness Stage 2's truth rule forbids us to risk for speed.
  The version-diff tool (P2.5) diffs two whole artifacts; it never mutates one
  into the other.
- The overlay store survives re-decompile by design (binding ids are
  binary-derived); `hbc2js render` against the new artifact re-applies it.

## 2. Index content (all keyed to `fnIndex` / binding ids)

### 2.1 `functions.jsonl` — one row per function

```json
{"fn":42,"name":"bytecodeName or null","params":3,"module":17,
 "parent":40,"kind":"normal|generator|async","offset":123456,"size":789,
 "overlayName":"<current overlay name or null>"}
```

`module` is the owning module id from the split module graph (null for
functions outside any `__d` factory, e.g. the global wrapper). `parent` is the
lexical parent fnIndex (from the closure graph src/cfg already builds).

### 2.2 `calls.jsonl` — the call graph

One row per call **site**:

```json
{"caller":42,"site":7,"callee":57,"kind":"closure","via":"direct"}
{"caller":42,"site":9,"callee":"?","kind":"unknown","why":"computed-callee"}
{"caller":42,"site":11,"callee":"g:fetch","kind":"global","via":"method"}
{"caller":42,"site":12,"callee":"m:17","kind":"require"}
```

- `site` is an ordinal (source order within the caller) — stable across
  renders because it is AST order, not line numbers; `ranges.jsonl` + the
  `context` query turn it into a `file:line` on demand.
- `callee` is one of: an integer `fnIndex` (closure resolved by the same
  CreateClosure/def-use dataflow the emitter already performs); `"g:<name>"`
  (call through a global binding, e.g. `g:fetch`, `g:JSON.parse` for one-level
  member calls on globals); `"m:<moduleId>"` (a `require(dependencyMap[i])`
  edge — this is how the module graph and call graph agree); `"b:<builtin>"`
  (CallBuiltin — see §2.5); or `"?"` with a mandatory `why`
  (`computed-callee`, `escaped-closure`, `reflect`, …). **`"?"` is a first-class
  answer.** Guessing a callee to make the graph look complete is the exact
  failure mode this format exists to prevent.
- `kind` ∈ `closure|method|construct|global|require|builtin|unknown`.
- **who-calls / called-by are both derived from this one edge list** (the query
  layer inverts it; the file stores each edge once).

### 2.3 String table → use sites

- **a. `strings.json`**: `{"sid":123,"v":"the string"}` for every table entry.
  Strings longer than 4 KB store `{"sid":…,"len":…,"sha256":…,"head":"first 256 chars"}`
  — the full value stays retrievable from the bundle via `hbc2js query string <sid> --full`;
  the index never silently truncates *without saying so* (truth rule: the
  record states it is a head, and how to get the rest).
- **b. `string-uses.jsonl`**: `{"sid":123,"fn":42,"role":"literal","n":2}` —
  role ∈ `literal|property-get|property-put|property-key|global-name|regexp|call-arg-literal`,
  `n` = site count in that function (site-level detail comes from the `context`
  query, not from disk — materialising every site explodes size for zero
  standing benefit). This file is what P2.3 (secrets indexer) scans.

### 2.4 `globals.jsonl` — global-read-where

`{"g":"XMLHttpRequest","fn":42,"access":"read|write|call","n":1}` — every
`GetGlobalObject`-rooted named access, aggregated per (global, fn, access).
This is the "who touches `nativeCallSyncHook` / `__fbBatchedBridge` /
`localStorage`" query and half of the native surface below.

### 2.5 `native.jsonl` — the native / host / module-boundary surface

The RE-critical file: where does JS meet the outside world.

```json
{"fn":42,"surface":"builtin","name":"b:HermesInternal.concat","n":1}
{"fn":42,"surface":"host-global","name":"g:nativeCallSyncHook","n":2}
{"fn":57,"surface":"bridge-module","name":"m:react-native/NativeModules","n":1}
```

- `builtin`: CallBuiltin/CallDirect targets from the disassembly (exact, from
  the opcode — never inferred).
- `host-global`: reads/calls of a curated host-name list (the RN bridge set:
  `nativeCallSyncHook`, `__turboModuleProxy`, `__fbBatchedBridge`,
  `nativeLoggingHook`, `HermesInternal`, plus web-ish hosts `fetch`,
  `XMLHttpRequest`, `WebSocket`). The list ships in the spec's test fixture and
  is versioned in the schema header — extending it is additive, never a
  re-interpretation.
- `bridge-module`: requires of modules that `src/deps` classified as the
  native-boundary packages (`react-native`, `expo-modules-core`, …) — reuses
  the deps evidence, does not re-derive it.
- This file is a *projection* of §2.2 + §2.4 for cheap querying; the checker
  (§4.1) verifies it agrees with them.

### 2.6 `modules.json` — module graph

Directly from the existing `SplitResult` / `MODULES.json` (spec 08): per module
`{id, file, factoryFn, deps:[ids], segment}` plus `entry` and a
`fnOwnership` map (`fnIndex → moduleId`, the transitive closure over the
lexical parent chain from each factory). Nothing new is computed here; this is
MODULES.json re-emitted under the index schema header so consumers have one
place to look. Exports/requires at the *symbol* level (what names a module
exports) are **not** in v1 (§6) — module-graph edges are id-level.

### 2.7 `ranges.jsonl` — the presentation layer (render-coupled)

Header carries `{"renderHash":"…"}`. One row per **function**:
`{"fn":42,"file":"src/foo.js","lines":[120,187]}`.

- Function granularity only. Register-level positions are served live by the
  `context` query (§3.3) from the warm frames — they are cheap to compute on
  demand and enormous to materialise.
- Regenerated wholesale on every render (§1.3). Any consumer holding a
  `file:line` across a re-render is holding a stale pointer — which is why
  every query answer that includes a `file:line` also includes the id, and ids
  are what tools store (Design D's rule, inherited here).

## 3. Query surface

**The files ARE the contract** — a tool that wants to stream everything reads
the JSONL directly (that is why the format is line-oriented and sorted). On top
of that, one query front-end, in two forms sharing one implementation:

- **Resident service** (primary for the LLM loop): `ArtifactService`, the same
  pattern as Design D's `NameService` (and in the same process — the loop holds
  one process with bundle parsed once, frames warm, index loaded). QUEUE
  P2.1a(a) applies: per-call CLI cold-start (1.23 s on a 3 KB fixture) is the
  anti-pattern; the loop drives the service.
- **CLI** `hbc2js query <verb> …` (thin wrapper for one-offs, tests, humans),
  next to the existing `name`/`render`/`segregate`/`deps` subcommands, and
  **listed in `--help`** (P2.1a(d) — the overlay's `name`/`render` omission
  gets fixed in the same commit that adds `query`).

### 3.1 Query verbs and their TOKEN COST OF USE (hard bounds)

Stage-2 rule, restated as the output contract: **every answer is ids + ranges +
one-line facts; never source, except the one verb whose job is source.** When a
cap truncates, the output SAYS so (`… 137 more; use --all/--page`) — a capped
answer that looks complete would be an untruth. Default caps; `--all` pages.

| verb | answer shape | bound (default) |
|---|---|---|
| `query fn <fn>` | one summary block: name, overlayName, module, file:lines, params, kind, edge counts in/out, native surface | ≤ 10 lines |
| `query who-calls <fn>` | one line per caller edge: `fn:12 src/a.js:45 method` | ≤ 50 lines + total |
| `query calls-from <fn>` | one line per callee edge (incl. `?` rows with `why`) | ≤ 50 lines + total |
| `query string <sid>` | the value (head if >4 KB unless `--full`) + use rows `fn role n` | ≤ 30 lines |
| `query string-grep <regex>` | matching `sid  head-of-value  useCount` rows | ≤ 50 lines + total |
| `query global-uses <name>` | `fn access n file:line` rows | ≤ 50 lines + total |
| `query native [--fn N]` | native-surface rows | ≤ 50 lines + total |
| `query module <id>` | deps, dependents, owned fn count, file | ≤ 15 lines |
| `query source <fn> [--lines a-b]` | rendered source of that fn (the ONLY source-emitting verb) | fn's own range |
| `name list <fn>` | live *nameable* registers: `r7 uses:3 role:<gate's role> named:userInput\|-` | ≤ 1 line/register |
| `name context <fn> <reg>` | defs/uses/assigned-from: `def L123 = call fn:57` / `use L130 arg-of g:fetch` | ≤ 40 lines + total |

`name list` / `name context` are QUEUE P2.1a(b) folded in: the gate already
computes each register's uses and role to decide `reuse-conflict`/`no-binding`
(`src/name-overlay/gate.ts`) — these verbs EXPOSE that computation instead of
making the caller render the whole function and re-derive it. They are served
from the warm frames + `ranges.jsonl` for line numbers; they need no new
analysis. A rename-verify (`P2.1a(c)`) falls out of `name context` — the
caller confirms a rename by re-reading ≤ 40 lines of sites, not a function.

### 3.2 Service API (mirrors the verbs; the loop imports this)

```ts
class ArtifactService {
  constructor(artifactDir: string)          // loads manifest + index, verifies hashes (§4.2)
  fn(fn: number): FnSummary
  whoCalls(fn: number, page?): Edge[]       // and callsFrom, stringUses, globalUses,
                                            // native, module — same rows as the CLI
  source(fn: number, lines?): string
  list(fn: number): NameableRegister[]      // P2.1a(b)
  context(id: RegisterId): SiteRow[]        // P2.1a(b)
}
```

Every method returns the already-bounded row set; there is no "give me the raw
graph" method — a tool needing the raw graph reads the JSONL files, which is
cheaper for both sides.

### 3.3 Live vs materialised — the rule

Materialised on disk: everything aggregate/per-function (§2). Computed live
from warm state: per-site register detail (`context`), source slices, `list`.
Rule of thumb enforced in review: **materialise what P2.5 needs to diff;
compute live what only an interactive caller needs.**

## 4. Truth guarantees

### 4.1 Recomputability + the checker

Every semantic-index edge is a pure function of (bundle bytes, producer
config). The checker `tools/artifact/check-index.ts`:

1. re-decompiles a sample of N functions (default 200, `--all` for every one)
   with the manifest's exact producer config,
2. independently re-walks their ASTs/disassembly to recount call edges, string
   uses, global accesses, native rows (a *separate, simple* walker — not the
   index builder called twice; same recompute-and-diff discipline as the pass
   checkers, D12),
3. diffs against the index rows for those functions. Any mismatch = FAIL with
   the row-level diff. `?`-edges must match as `?` with the same `why` class.

The checker is wired into `test:all` on fixtures and runnable standalone on any
artifact (`hbc2js query check`), so a Stage-2 loop can spot-check the artifact
it was handed before trusting it.

### 4.2 Staleness is an error, never a wrong answer

- `ArtifactService` construction and every CLI invocation verify:
  `ranges` header renderHash == manifest `render.hash`; manifest
  `index.builtFor` == manifest `bundle`+`producer`; overlay file hash ==
  `render.overlayHash` (else line numbers may have drifted).
  Mismatch → `E_STALE_INDEX` / `E_STALE_RANGES`, exit non-zero, no output.
  There is no `--force`; the fix is `hbc2js render`/re-index, never "answer
  anyway".
- `?` edges are never upgraded by the query layer. `who-calls` output includes
  a trailing line `unknown-callee edges in scope: K` whenever K > 0, so an
  LLM consumer knows the caller list may be incomplete *and knows by how much*.
  That line is load-bearing: completeness claims are part of the answer.

### 4.3 INCONCLUSIVE propagation

Where the decompile itself was degraded (e.g. split diagnostics like the
E_UNBOUND_IDENT keep-bodies path in `src/split/index.ts`), the manifest gets
`"degraded": ["…diagnostic…"]` and every query on an affected function
prefixes its answer with `! degraded: <reason>`. Mirrors the harness rule:
INCONCLUSIVE is never PASS.

## 5. Decision-8 quadruple (metric / target / method / held-out)

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Index truth**: checker (§4.1) agreement on N=200 sampled functions — unmarked-wrong edges (index says X, recount says Y, neither is `?`) | **0** (derived data; any disagreement is a bug). `?`-rate is *reported*, not targeted — but every `?` must carry a `why` (checker enforces 100% of `?` rows have one) | `tools/artifact/check-index.ts --sample 200 --seed 1` on the held-out bundle |
| 2 | **Query token cost**: bytes/lines per answer over the fixed query corpus (every verb × 30 sampled args) | every answer within its §3.1 cap; median `who-calls` ≤ 2 KB; median `fn` ≤ 800 bytes; `context` ≤ 40 lines always | `tools/artifact/measure.ts` runs the corpus, emits max/median per verb |
| 3 | **Run cost**: semantic index build wall-time as fraction of decompile+render wall-time; on-disk index size vs rendered source size | build ≤ 25% of decompile time; `index/` ≤ 30% of rendered-source bytes (both on rn-template AND the held-out bundle) | same `measure.ts`, best-of-3 |
| 4 | **Held-out check** | targets 1–3 hold unchanged on a bundle never used while building/tuning the extractor | tune on `tests/fixtures/bundles/rn-template` + construct fixtures; **measure on the react-navigation bundle (`fetch.sh`)**, plus a hash-recorded local-corpus app spot-check (numbers in the report, bundle never in the repo) |

`measure.ts` prints one summary block; the acceptance suite (§7) asserts
targets 1–2 in `test:all` (oracle-gated where a bundle must be fetched) and the
implementer's landing report states all four measured numbers.

## 6. Non-goals (v1) and where they attach later

- **Type/shape recovery, protocol/wire-format reconstruction**: not in v1.
  Attach point reserved: a future `index/shapes.jsonl` keyed to the same
  binding ids; the schema header's `kind` registry is the extension mechanism.
- **Symbol-level exports/imports** (which *names* a module exports): v1 module
  graph is id-level (§2.6). Attaches later as `index/symbols.jsonl`.
- **Tags/comments/findings**: P2.2's project store, which wraps this artifact
  directory and the overlay — one new sidecar per record type, same ids, not
  this spec.
- **Incremental semantic re-index** across bundle versions: P2.5 diffs whole
  artifacts instead (§1.3).
- **Site-level string/global positions on disk**: served live (§3.3).
- **Cross-artifact identity** (same fn across two app versions): P2.5's
  problem (fnIndex is NOT stable across app versions); this spec only promises
  stability across re-renders/re-decompiles of the SAME bytes.

## 7. Acceptance tests

Spec-agent note: this spec's write scope was restricted to `docs/specs/` (a
concurrent agent owns the gate and `tests/` adjacency), so the
pre-implementation-runnable test ships here **verbatim** and the implementer
materialises it unchanged as step 0 — its assertions are the spec's, not the
implementer's (CONSOLIDATION §B item 8 intent preserved; landing report must
say "A1 taken verbatim from spec §7").

**A1 (pre-impl, runnable on a hand-written sample): format self-consistency.**
`tests/artifact/format-schema.test.ts` + fixture `tests/artifact/sample-artifact/`
(a tiny hand-written artifact: manifest, 3-function index, 1-module graph).
Asserts: every index file's first line is a schema header with `kind` and
`renderIndependent`; every subsequent line parses as JSON with exactly the §2
fields for its kind; rows sorted by primary key; every `callee:"?"` row has
`why`; `ranges` header `renderHash` equals manifest `render.hash`; every
binding key round-trips through `parseKey` (`src/name-overlay/id.ts`).

```ts
// tests/artifact/format-schema.test.ts  (verbatim; implementer materialises)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = new URL("./sample-artifact/", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const jsonl = (f: string) => readFileSync(join(dir, "index", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
test("A1a every index file has a schema header", () => {
  for (const f of readdirSync(join(dir, "index")).filter((f) => f.endsWith(".jsonl"))) {
    const [head] = jsonl(f);
    assert.match(head.schema, /^hbc2js-index\/1$/);
    assert.equal(typeof head.kind, "string");
    assert.equal(typeof head.renderIndependent, "boolean");
  }
});
test("A1b unknown callees carry a reason; known ones don't need one", () => {
  for (const row of jsonl("calls.jsonl").slice(1))
    if (row.callee === "?") assert.equal(typeof row.why, "string");
});
test("A1c ranges are tied to the manifest's render hash", () => {
  const [head] = jsonl("ranges.jsonl");
  assert.equal(head.renderIndependent, false);
  assert.equal(head.renderHash, manifest.render.hash);
});
test("A1d calls rows sorted by (caller, site)", () => {
  const rows = jsonl("calls.jsonl").slice(1);
  const keys = rows.map((r) => [r.caller, r.site]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});
```

**Specified for the implementer (paths + assertions; each fails before its
step lands and passes after):**

- **A2 build-on-fixture** (`tests/artifact/build.test.ts`): build the artifact
  for `tests/fixtures/bundles/rn-template`'s bundle; assert manifest hashes
  verify, every `fnIndex` in `functions.jsonl` exists in the bundle
  (count == `bundle.functionCount`), `modules.json` agrees with the existing
  `MODULES.json` id-for-id, and `fnOwnership` covers every factory's lexical
  descendants.
- **A3 checker soundness** (`tests/artifact/check-index.test.ts`): run the
  §4.1 checker `--all` on a construct fixture's artifact → PASS; then corrupt
  one `calls.jsonl` row (flip a callee) in a temp copy → checker FAILS naming
  that row. (The corrupt half is the regression test for "checker actually
  checks".)
- **A4 staleness** (`tests/artifact/stale.test.ts`): re-render with one
  overlay name changed WITHOUT regenerating ranges (temp copy, edit
  manifest.render.hash) → every query verb and `new ArtifactService` throw
  `E_STALE_RANGES`; after a proper re-render, queries succeed and the changed
  fn's range is updated.
- **A5 rename-survival** (the point of binding ids)
  (`tests/artifact/rename-survival.test.ts`): build artifact; `name set` on a
  register; re-render; assert the SEMANTIC index files are byte-identical
  (their hashes unchanged in the manifest) and `who-calls`/`context` answers
  are id-identical before and after — only `file:line` values and
  `overlayName` may differ.
- **A6 query bounds** (`tests/artifact/query-bounds.test.ts`): on rn-template's
  artifact, for every §3.1 verb over a sampled arg set: output within its cap;
  a deliberately high-fan-in fn shows the truncation marker AND the correct
  `total:`; `who-calls` on a fn with `?` edges in scope prints the
  `unknown-callee edges in scope: K` line with the right K.
- **A7 `name list`/`context` truth** (`tests/artifact/name-queries.test.ts`):
  on a construct fixture, `name list <fn>` returns exactly the registers the
  gate considers nameable (assert against `gateForFrame` outcomes: every
  listed reg gets past `no-binding`; the QUEUE's wasted `{0,9}` probe class
  never appears); `context` site count equals an independent AST recount.
- **A8 decision-8 measurement** (`tests/artifact/targets.test.ts`, in
  `test:all`, `HBC2JS_REQUIRE_ORACLES`-gated for the fetched bundle): runs
  `measure.ts` + checker per §5 and asserts targets 1–2; prints 3–4 for the
  landing report.
- **A9 CLI discoverability** (extend the existing CLI help test file if one
  exists, else `tests/artifact/cli-help.test.ts`): `hbc2js --help` mentions
  `query`, `name`, and `render` (P2.1a(d)).

Test-count rule: all additions, no existing test touched; baseline only rises.

## 8. Implementation plan (lean-agent-sized, ordered; reuse column is binding)

| step | delivers | reuses | new |
|---|---|---|---|
| 0 | materialise A1 test + sample fixture verbatim from §7; commit red-green harness for the format | — | `tests/artifact/*` |
| 1 | `src/artifact/schema.ts` (row types, header, hashing) + `manifest.json` writer wired into decompile/split CLI path; A1 green on real output | `src/split` output path, `bindingKey` | schema + manifest |
| 2 | `functions.jsonl` + `modules.json` + `ranges.jsonl` (builder walks what split/segregate already produce; renderer records fn line ranges as it prints) | `SplitResult`, `MODULES.json`, segregate, emitter's provenance walk | range recording hook |
| 3 | `calls.jsonl` (closure-resolution from the emitter's existing CreateClosure def-use; `require` edges from `src/split/rewrite.ts`'s recogniser; `?` discipline) — A2 | emit dataflow, split rewrite | edge extractor |
| 4 | `strings.json` + `string-uses.jsonl` + `globals.jsonl` | parse string table, disasm operand walk | use-site walker |
| 5 | `native.jsonl` projection + host-name list | §2.2/§2.4 outputs, `src/deps` classification | projection + list |
| 6 | checker `tools/artifact/check-index.ts` (independent walker) — A3 | disasm | checker |
| 7 | staleness enforcement in a new `ArtifactService` + `hbc2js query` CLI verbs incl. bounds/truncation — A4, A6, A9 | `NameService` pattern, CLI | service + verbs |
| 8 | `name list` / `name context` from gate internals + warm frames — A5, A7 | `src/name-overlay/gate.ts`, `frames.ts` | two verbs |
| 9 | `measure.ts` + A8; run held-out measurement; landing report with the four numbers | harness timing patterns | measure script |

Each step is one commit with its tests; steps 3–5 are independent of 7–8 and
can run as parallel lean agents once 1–2 land.

## 9. Open questions for the reviewer

1. §2.2 `site` ordinal: AST source order is proposed for render-stability; is
   instruction offset better for the checker's independent recount (more
   binary-anchored), at the cost of meaning nothing to a human? (Proposal
   stands: ordinal in rows, checker matches by multiset per caller.)
2. §2.5 host-global curated list: ship in-repo as data with schema-versioned
   additions — is review-per-addition enough governance, or should unknown
   `g:` names above a use-count threshold be auto-surfaced as
   `surface:"host-global?"` candidates?
3. §5 target 3 (build ≤ 25% of decompile time): sane on rn-template; if the
   held-out bundle blows it because closure resolution dominates, is the
   fallback "resolve `?` lazily in the query layer" acceptable, or does that
   violate the materialise-what-P2.5-diffs rule?
4. `E_STALE_INDEX` with no `--force` (§4.2): deliberate hard line; confirm no
   Stage-2 consumer needs read-only access to a knowingly-stale artifact
   (e.g. P2.5 archiving old versions — proposal: archived artifacts are
   internally consistent, so they verify against their own manifest and this
   never bites).

## 10. Review responses

(placeholder — decision-8 gate reviewer writes here)
