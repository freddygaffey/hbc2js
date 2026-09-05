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
    calls-resolved.jsonl   # §2.2a `require(N)` points-to edges (additive)
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
  directory — overwriting an existing one requires an explicit `--overwrite`;
  the default refuses, so archived artifacts stay internally consistent
  (§9 q4 ruling, §10). The semantic layer is rebuilt from scratch.
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
 "parent":40,"kind":"normal|generator|async","offset":123456,"size":789}
```

`module` is the owning module id from the split module graph (null for
functions outside any `__d` factory, e.g. the global wrapper). `parent` is the
lexical parent fnIndex (from the closure graph src/cfg already builds).
**No `overlayName` on disk** (reviewer edit, §10): storing the current overlay
name here would make `functions.jsonl` render-dependent and break A5's
byte-identical guarantee. The query layer joins the overlay store live;
`query fn` still reports `overlayName`.

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
  failure mode this format exists to prevent. Member chains on a global
  deeper than one level, or routed through an intermediate register the
  extractor cannot prove untouched, are `"?"` with `why:"deep-global-member"`
  — never a truncated `g:` guess (reviewer edit, §10).
- `kind` ∈ `closure|method|construct|global|require|builtin|unknown`.
- **who-calls / called-by are both derived from this one edge list** (the query
  layer inverts it; the file stores each edge once).

### 2.2a `calls-resolved.jsonl` — the `require(N)` points-to edges

One row per call site the points-to pass (`src/artifact/points-to.ts`, spec 17
§14.4) resolved through a `require(dependencyMap[N])` receiver — the sites
`calls.jsonl` records as `{"callee":"?","why":"computed-callee"}` because the
callee register holds a required module's export:

```json
{"caller":8,"site":15,"callee":4,"module":0,"name":"run","confidence":"points-to"}
```

- `site` is a function-relative OFFSET (pc) of the call instruction, NOT
  `calls.jsonl`'s ordinal `site` — this index is written by a separate,
  decode-only pass that never builds the ordinal.
- `callee` is always an integer `fnIndex`; `module`/`name` say which module
  export it was reached through (`name` is the reserved key `module.exports`
  when the module's whole export value is the callee, i.e.
  `module.exports = function …`).
- `confidence` is always `"points-to"`. It exists so no consumer can mistake
  a recovered edge for a direct one.

**Why a separate file, not extra rows in `calls.jsonl` (decision, 2026-09-05).**
Three reasons, in order: (1) `calls.jsonl`'s primary key is
`(caller, site-ordinal)` and these rows have no ordinal — folding them in
would either invent one or overload `site` with two meanings; (2) an existing
reader of `calls.jsonl` (the native index, the secrets xref, `src/mcp/leads.ts`,
every committed test) keeps reading EXACTLY what it read before, so nothing
has to be re-verified for a false "new edge appeared"; (3) the file is
optional on read (`ArtifactService` tolerates its absence), which is what
makes an artifact written before this pass existed still load. The merge
happens at query time in `who-calls`/`calls-from`, where the marker travels
with the row.

The file is `renderIndependent: true` and IS hashed into
`manifest.index.semanticHash` (§1.2) like every other semantic index — it is
derived from bytecode alone, so a rename or a re-render leaves it
byte-identical.

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
{"fn":57,"surface":"bridge-module","name":"m:17","n":1}
```

- `builtin`: CallBuiltin/CallDirect targets from the disassembly (exact, from
  the opcode — never inferred).
- `host-global`: reads/calls of a curated host-name list (the RN bridge set:
  `nativeCallSyncHook`, `__turboModuleProxy`, `__fbBatchedBridge`,
  `nativeLoggingHook`, `HermesInternal`, plus web-ish hosts `fetch`,
  `XMLHttpRequest`, `WebSocket`). The list ships in the spec's test fixture and
  is versioned in the schema header — extending it is additive, never a
  re-interpretation. Governance (reviewer ruling, §10): the list is an in-repo
  data file pinned by a test (A10), appended only via a reviewed commit citing
  evidence; the builder additionally auto-surfaces any *unlisted* global with
  read/call use in ≥ 3 functions as `surface:"host-global?"` — a marked
  candidate, never silently promoted; promotion = editing the data file.
- `bridge-module`: `calls.jsonl` `kind:"require"` edges (§2.2, `callee`
  already `"m:<moduleId>"`) whose target module `src/deps/classify.ts`
  classified `library` with a `libraryPackageHint` naming one of the curated
  native-boundary packages (`react-native`, `expo-modules-core`, …,
  `src/artifact/native-boundary-packages.ts`) — `name` re-emits the exact
  `calls.jsonl` `callee` string (`"m:<moduleId>"`, never a re-derived
  package/subpath name: `src/deps`'s naming stage is a separate, unconfirmed
  hint — §6 keeps symbol-level require naming out of v1). Builder
  (`buildNativeIndex`, `src/artifact/native.ts`): takes a caller-supplied
  `ClassificationReport` for this bundle when the caller already has one
  (`WriteArtifactOptions.classification`), else builds one cheaply from the
  bundle's own inventory with an empty commonality index (D17j's signals need
  no cross-app corpus). Measured (docs/AGENT-LOG.md 2026-09-04): on the
  committed `rn-template-0.72` fixture and on a large (12.7 MB, 4,510-module)
  production bundle, `classify.ts`'s string-evidence signals never fire at
  all — Metro strips `node_modules/`-shaped require paths from optimised
  output (`classify.ts`'s own file header) — so `bridge-module` is honest but
  empty on those bundles today; it fires once a caller supplies a
  `ClassificationReport` built with real evidence (a populated commonality
  index, or `src/deps`'s npm-confirm stage). Never a guessed row either way —
  truth rule.
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

### 2.8 `native/*` — the APK's native half (spec 27)

Written by `src/native/ingest.ts` (spec 27 L1), **beside** `index/`, never
inside it: `native/{classes,methods,strings,resources,assets,react-modules,
seams,env}.jsonl` + `native/manifest.json` (the decoded AndroidManifest) +
`native/ingest.json`
(the provenance block, also merged into this artifact's `manifest.json` under
`native` when one exists). Header schema is `hbc2js-native/1` with a `source`
of `dex|axml|arsc|zip`; rows are sorted by primary key so a diff is a line
diff, exactly like `index/`.

Native binding keys (`native:type:`, `native:method:`, `native:str:`,
`native:res:`, `native:module:`) are namespaced siblings of `src/name-overlay/
id.ts`'s `reg:`/`env:`/`fn:` keys and are constructed only by that file's
`nativeKey()` helpers. §4's truth rules apply unchanged, plus two
native-specific ones (spec 27 §4): a method-body value the minimal DEX parser
cannot read stays unresolved rather than being guessed, and asset/resource
**bytes are never copied into a table** — assets are inventory only
(path/size/sha256/kind). Full contract, landing sequence and refusal posture:
`docs/specs/27-native-side.md`.

`native/react-modules.jsonl` (spec 27 L2, `src/native/react-modules.ts`) is
derived purely from `classes.jsonl` + `methods.jsonl` above (never from raw
DEX bytes again): one row per recognised React Native module registration
(`bridge`/`turbo`/`viewmanager`), keyed `native:module:<jsName>` (or
`native:module:<implClass descriptor>` when the name is unresolved — still a
real, unguessed identity, never a fabricated one). `nameEvidence` is
`annotation` (`@ReactModule(name=...)`), `getName-const` (the one bounded
method-body exception: a `getName()` whose entire body is
`const-string`+`return-object` on the same register — a fixed 6-byte pattern
match, not a general instruction interpreter — see `dex.ts`'s
`decodeTrivialStringReturn`), `classname` (RN codegen's `Native<X>Spec` ->
`X` naming convention for TurboModule spec classes with no annotation), or
`unresolved` (the row is still emitted, `jsName:null` — never dropped, never
invented). `firstParty` is always `null` from `buildReactModules` itself; L4
(`src/native/classify-party.ts`) fills it in `buildNativeTables` right after,
using L1's own decoded manifest `package`: `true` when the impl class's Java
package equals, or is a dot-bounded subpackage of, the manifest package;
`false` when it falls under a curated third-party native-module package
prefix (`src/native/third-party-packages.ts` — same append-only,
evidence-cited governance as `src/artifact/native-boundary-packages.ts`,
seeded from and cross-checked against the deps signature DB under
`tools/pkgsig/db`); `null` when neither applies (unresolved, surfaced for the
human, never guessed either way).

`native/seams.jsonl` (spec 27 L3, `src/native/seams.ts`) is the JS<->native
**join**, written only when this directory holds BOTH a JS artifact
(`index/strings.json` + `index/string-uses.jsonl` + `index/globals.jsonl`) and
the native tables above; with no JS half the file is simply absent (an absent
seam table says "not joinable", which is the truth). Its header `source` is
`join` — the one native table that is not a byte reading: every signal it uses
is already materialised by `src/artifact/*` or by `react-modules.jsonl`, and
nothing is re-derived from bytecode or DEX bytes here. Row:

```json
{"key":"seam:Crypto.generateKey","jsName":"Crypto","jsMethod":"generateKey",
 "jsEvidence":{"stringUses":["sid:41"],"callSites":["fn:3"],"resolved":"string-only"},
 "native":{"module":"native:module:Crypto","method":"native:method:Lcom/example/seam/CryptoModule;->generateKey(Ljava/lang/String;Lcom/facebook/react/bridge/Promise;)V"},
 "status":"linked","channel":"NativeModules","firstParty":null}
```

(`firstParty` above is shown `null` as `buildSeams` itself always emits it —
`writeSeams` labels it right after, inheriting the linked/native-only row's
native module's own L4 label; a `js-only` row has no native class to
classify and stays `null`. See L2's paragraph above for the label's rule.)

- **`status`** is `linked` (both halves), `js-only` (a JS reference with no
  native impl in this APK — `native:null`, a real unresolved boundary, never
  dropped and never guessed) or `native-only` (a native module no JS reference
  reached — `jsEvidence:null`, symmetric with `native:null`).
- **`channel`** names the JS-side host anchor the row came from
  (`NativeModules` member reads, a `TurboModuleRegistry` string literal, a
  `requireNativeComponent` string literal); `null` on a `native-only` row.
- **Matching is exact name equality or nothing** (spec 27 §4.3): a JS `Crypto`
  never links to a native `CryptoStore`. `jsMethod` is likewise only claimed
  when the JS side uses a member string that exactly equals one of that
  module's exported native methods.
- **`resolved`** is the strength of the JS-side evidence
  (`points-to|by-name|string-only`). **Known gap (v1): every row is
  `string-only`.** The materialised JS tables carry no receiver for a
  host-object member chain — `calls-resolved.jsonl` resolves `require(N)`
  module exports only, and `string-uses.jsonl` gives the same `property-get`
  role to the `X` of `NativeModules.X` and the `m` of `X.m`. Consequence, also
  recorded in `docs/BUGS.md`: in the `NativeModules` channel a member string
  that matches no native module and is not consumed as a linked module's
  method is reported as a `js-only` seam, so an unresolved boundary is never
  dropped, at the cost of over-reporting method names as candidate modules. A
  `js-only` row is an unresolved boundary, never a claimed link, so this can
  never fabricate a seam. Closing the gap is a JS-side change (a distinct
  host-member string-use role, or a receiver on a resolved call edge), not an
  L3 one — L3 never invents a signal.

**Landed (2026-09-05, spec 27 §L5).** Read verbs over `native/*` (L1-L4):
`ArtifactService.nativeModules()`/`.nativeModule(x)`/`.seams(filter)`/
`.nativeManifest()`/`.nativeResources(pattern)`/`.nativeImplFor(fn)`
(`src/artifact/service.ts`), mirrored on `McpResources` (`src/mcp/
resources.ts`), the CLI (`hbc2js query native modules|module <X>|seams|
manifest|resources`, §3.1 below) and `GET /api/native/{modules,module/:x,
seams,manifest,impl/:fn}` (`src/ui-server/native.ts`). The UI Context pane's
"native impl" row (`ui/src/panes/context-native.ts` + `RightPane.tsx`) reads
`impl/:fn`. Every reader answers empty/null rather than throwing when a
project has no native side ingested; staleness is inherited for free — a
stale artifact's `ArtifactService` construction already refuses with
`E_STALE_INDEX` before any native verb can run.
`native/env.jsonl` (spec 27 §L6, `src/native/env.ts`) is `.env` recovery from
two channels, joined over tables L1 already materialised (header `source` is
`join`, like `seams.jsonl` — nothing is re-derived from bytes here): a
**strings.xml** row for every `resources.jsonl` `"string"`-type resource whose
name looks like an env key (all-caps + underscores — a label/filter on THIS
derived table only; the resource itself is always still a normal
`resources.jsonl` row regardless) and resolves to a plain string value; a
**BuildConfig** row for every `static final String` field of a class named
`BuildConfig` (`Lx/y/BuildConfig;`), read from the DEX `static_values`
compile-time-constant table alongside `classes.jsonl`/`methods.jsonl` during
the same DEX pass. Row: `{"key":"API_URL","value":"https://...",
"source":"strings.xml","resolvedBy":"own-parser"}`. `strings.xml` values are
always plain ARSC data, so that channel either produces a real value or no row
at all — never `"unresolved"`. A `BuildConfig` field's value lives in
`static_values` when it is a compile-time constant; when it is not (only ever
assigned in `<clinit>`, a method body the minimal parser does not read — spec
27 §1.2's documented gap) the row is still emitted with `value:"unresolved"`,
`resolvedBy:"none"` — the key is a real, honest fact even when the value is
not. `resolvedBy:"baksmali"` is reserved for the optional external oracle
(§1.2); v1 never sets it.

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
| `query who-calls-by-name <fn:N \| --name X>` | NAME-based caller recovery for `<slot>.export(...)` dispatch `who-calls` can't resolve; one line per candidate: `fn:12 name:foo property-get n:1 … confidence:by-name` (spec 17 §14.1). `fn:N` proves N's export names from bytecode (needs `--hbc`) then scans other modules; `--name X` scans one name. Common/high-fan-out names → `ambiguous`, no rows. | ≤ 50 lines + total |
| `query calls-from <fn>` | one line per callee edge (incl. `?` rows with `why`) | ≤ 50 lines + total |

Both `who-calls` and `calls-from` MERGE the §2.2a points-to edges into their
rows; a merged row prints its marker (`… method confidence:points-to
via:m:3.module.exports`) and carries `confidence`/`exportName`/`module` in
`--json`. Rows without the marker are exactly the direct `calls.jsonl` edges
they always were.

| `query string <sid>` | the value (head if >4 KB unless `--full`) + use rows `fn role n` | ≤ 30 lines |
| `query string-grep <regex>` | matching `sid  head-of-value  useCount` rows | ≤ 50 lines + total |
| `query global-uses <name>` | `fn access n file:line` rows | ≤ 50 lines + total |
| `query native [--fn N]` | native-surface rows | ≤ 50 lines + total |
| `query native modules` \| `native module <X>` \| `native seams [--status linked\|js-only\|native-only] [--first-party]` \| `native manifest` \| `native resources --key <re>` | spec 27 §L5's native/ table read verbs (`react-modules.jsonl`/`seams.jsonl`/`manifest.json`/`resources.jsonl`); `native module <X>` returns the module, its methods AND every seam citing it in one call — no N+1. Distinct verb space from the legacy `query native [--fn N]` above (that one is the JS-side host-access surface, `native.jsonl`); told apart by the first positional token. Empty/null, never an error, when no native side was ingested into this artifact. | modules/seams ≤ 100 rows + total; resources ≤ 50 rows + total; module/manifest one block |
| `query object-tables [--min-props N] [--string-ratio R] [--key <re>] [--value <re>] [--min-matched N] [--module M] [--limit N]` | bundle-wide inventory of CONSTANT object literals (`NewObjectWithBuffer*`): a `fn N @off  module M  keys=K strings=S matched=M` header then `key: value` lines (`<computed>` for a member built at runtime). Default filter ≥ 4 members and ≥ 50% string-valued; `--key`/`--value` are ECMAScript regexes and a table matches if ANY member does. `matched` = members satisfying those patterns (the member count when neither is given), `--min-matched` (default 1) drops the accidental hit. Ranked by `matched`, then hit density, then size when filtered; by size alone when not. Live verb (needs `--hbc`); one O(instructions) scan, memoised per service (spec 17 §14.2) | ≤ 100 tables (`--limit`/`--all`), ≤ 20 member lines each + total |
| `query template-injections [--module M] [--limit N]` | bundle-wide WebView-injection anti-pattern scan (hunt lead C1): a template literal / `+` chain whose static text quotes a runtime substitution, e.g. `` `window.foo('${x}')` `` or `"x = '" + x + "'"`. One line per row: `fn:N @off module:M kind:template|concat subs-in-quotes:S/nSubs 'quote'` then the prefix/suffix around the quote (capped ~120 chars, holes shown as `${…}`). Ranked by substitutions-inside-quotes desc, then `fn`. Live verb (needs `--hbc`); one O(instructions) scan, memoised per service (spec 17 §14.3) | ≤ 100 rows (`--limit`/`--all`) + total |
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
  anyway". Consequence (reviewer edit, §10): a `name set` alone changes the
  overlay hash, so the next line-bearing query is stale until `hbc2js render`
  runs. By design — the loop's pattern is batch-set → render → query (Design D
  batch set, QUEUE P2.1a(a)); the render is the price of true line numbers,
  paid once per batch, never per name.
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
| 1 | **Index truth**: checker (§4.1) agreement on N=200 sampled functions — unmarked-wrong edges (index says X, recount says Y, neither is `?`) | **0** (derived data; any disagreement is a bug). `?`-rate is *reported*, not targeted — but every `?` must carry a `why` (checker enforces 100% of `?` rows have one) | `tools/artifact/check-index.ts --sample 200 --seed 1` on the held-out bundle, plus one `--all` run on rn-template (small enough); both in the landing report |
| 2 | **Query token cost**: bytes/lines per answer over the fixed query corpus (every verb × 30 sampled args) | every answer within its §3.1 cap; median `who-calls` ≤ 2 KB; median `fn` ≤ 800 bytes; `context` ≤ 40 lines always | `tools/artifact/measure.ts` runs the corpus, emits max/median per verb |
| 3 | **Run cost**: semantic index build wall-time as fraction of decompile+render wall-time; on-disk index size vs rendered source size | build ≤ 25% of decompile time (met, 2026-09-03 close-out); `index/` ≤ 70% of rendered-source bytes (renegotiated 2026-09-03, was ≤ 30% — §10 "P2.1 close-out size renegotiation", both on rn-template AND the held-out bundle) | same `measure.ts`, best-of-3 |
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
- **A10 host-global governance** (`tests/artifact/host-globals.test.ts`):
  the curated list used by the builder matches the in-repo data file exactly
  (pin), and a fixture bundle with an unlisted bridge-like global used in ≥ 3
  functions yields `host-global?` rows, never `host-global`.
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

### Review responses (2026-09-03, Fable reviewer gate — decision 8)

**VERDICT: APPROVED.** Implementation may launch at step 0 (§8). All issues
found were resolvable by small in-place reviewer edits (marked "reviewer
edit/ruling, §10" in the text and enumerated below) plus the four §9 rulings.
No CHANGES REQUIRED items remain.

**Checklist findings**

1. *Decision-8 quadruple*: complete and sane. Targets (0 unmarked-wrong edges;
   per-verb caps; build ≤ 25% decompile time; index ≤ 30% source bytes;
   held-out = react-navigation via fetch.sh, present in
   `tests/fixtures/bundles/`) are measurable and the scripts
   (`check-index.ts`, `measure.ts`) are named with exact invocations. On
   sample size: 0-in-200 random functions bounds the per-fn error rate at
   ~1.8% with 98% confidence — adequate as the *gate* metric only because the
   checker already supports `--all` (§4.1) and A3 runs `--all` on a construct
   fixture. Reviewer edit E3 additionally requires one `--all` run on
   rn-template in the landing report, so at least one full-bundle exhaustive
   check backs the truth claim.
2. *§9 rulings*: below.
3. *Truth audit*: one real inconsistency found and fixed — `overlayName`
   stored in `functions.jsonl` (§2.1) made a semantic-layer file
   render-dependent, contradicting A5's byte-identical assertion and the §0
   layer split (edit E1: dropped from disk, joined live). Second gap: the
   one-level-member rule for `g:` callees left deeper chains unspecified — a
   partial `g:` record would be a silent truncation (edit E2: deeper chains
   are `?` with `why:"deep-global-member"`). Checker independence is
   correctly specified (§4.1 "separate, simple walker", D12 discipline);
   note for the implementer: the checker's closure resolution in step 6 must
   be its own def-use over the disassembly, NOT an import of the emitter's —
   otherwise callee edges are the builder checked against itself. The shared
   AST *production* is unavoidable (it is the object under test); only the
   extraction must be independent.
4. *Efficiency audit*: every §3.1 verb has a cap; `query source` is the only
   source-emitting verb; `name list`/`name context` match QUEUE P2.1a(b)
   exactly (exposing `gateForFrame`'s existing role/use computation —
   verified present in `src/name-overlay/gate.ts`), and P2.1a(c) verify falls
   out of `context`. P2.1a(a) batch `name set` is correctly OUT of this spec
   (QUEUE marks it independent of xref; it lands on the overlay's
   NameService) — but note edit E5: because any `name set` stales the ranges,
   the batch-set → render → query pattern is now documented as the intended
   loop shape, which makes (a) a prerequisite for a pleasant loop, not just a
   quick win. `name list` is bounded by frame register count (fine).
5. *Consistency*: binding keys defer to `src/name-overlay/id.ts`
   `bindingKey`/`parseKey` (verified to exist); overlay store stays owned by
   spec D, referenced not respecified; renames stay gate-routed. Schema ids
   `hbc2js-artifact/1`/`hbc2js-index/1` are disjoint from the fuzz spec's
   `fuzz-matrix/1`, both sides self-describe and refuse unknown schemas, and
   the responsibilities do not overlap (fuzz matrix = run outcomes; index =
   program facts). No collision.
6. *Implementation plan*: steps 0–9 are lean-agent-sized (one file family +
   its test each), the reuse column pins each step to existing code, and
   steps 3–5 ∥ 7–8 parallelism is real. Step 0 is correctly specified: A1
   test code ships verbatim in §7 with the materialise-unchanged instruction
   and the landing-report attestation line, preserving CONSOLIDATION §B
   item 8 despite the spec agent's restricted write scope.

**The four §9 rulings**

1. **Call-site key: AST ordinal — proposal stands.** Rationale: the semantic
   layer is rebuilt whenever the AST could change (`index.builtFor` covers
   producer config incl. passes), so ordinal instability across pass changes
   never bites within one artifact; renders are alpha-renaming only, so
   ordinals are render-stable. For P2.5, neither key survives an app-version
   change (fnIndex itself does not, §6) — functions must be matched first
   regardless — and ordinals produce strictly smaller line diffs than offsets
   (an edit renumbers offsets for the whole rest of the function/bundle, but
   ordinals only within one caller past the edit). Instruction offsets are
   also not reliably available post-pass (rewrites merge/move instructions).
   The checker matches by multiset per caller, as proposed, so it never
   depends on the key. Overlay binding ids are untouched (they contain no
   site component).
2. **Host-global list: both curation AND auto-surfacing** (edit E6 + A10).
   Curated list = in-repo data file, pinned exactly by test A10, appended
   only via a reviewed commit citing evidence — that review-per-addition IS
   enough governance once the pin makes silent drift impossible. Unlisted
   globals with read/call use in ≥ 3 functions are auto-surfaced as
   `surface:"host-global?"` — truth-safe because the `?` marks it a
   candidate; promotion to `host-global` only ever happens by editing the
   data file, never by the builder.
3. **Lazy `?`-resolution fallback: REJECTED.** Storing `?` for edges that are
   resolvable-but-deferred breaks the files-are-the-contract rule (a direct
   JSONL reader sees an artificially incomplete graph), produces spurious
   P2.5 diffs (deferred-in-A vs resolved-in-B), and violates §3.3's own rule
   — call edges are exactly what P2.5 diffs, so they must be materialised.
   `who-calls` also requires the full inverted edge set, so laziness buys
   nothing there. If the 25% budget blows on held-out: optimise, or come back
   through this gate with the measured number and renegotiate the budget
   openly — run cost is criterion (2) and loses to truth; the budget number
   may move, the graph's completeness may not.
4. **No stale read access: CONFIRMED, with one edit.** The long-session case
   (LLM holds an artifact while a re-decompile happens) is solved by
   immutability, not by a `--force`: edit E4 makes re-decompile write a NEW
   directory by default (`--overwrite` explicit), so an old artifact remains
   internally self-consistent — its own manifest verifies, every query
   against it is true *of that decompile*, and "knowingly stale" never means
   "internally inconsistent". P2.5 archival works the same way. The only
   in-place mutation is re-render, which bumps hashes and is exactly what
   `E_STALE_RANGES` detects. No consumer needs to read an artifact that
   fails its own manifest.

**Reviewer edits applied in place (all marked in the text)**

- E1 (§2.1): `overlayName` removed from `functions.jsonl`; served by live
  join in `query fn`. Fixes the A5 / render-independence contradiction.
- E2 (§2.2): deep (>1-level) global member chains → `?` with
  `why:"deep-global-member"`, never a truncated `g:` record.
- E3 (§5 row 1): one checker `--all` run on rn-template added to the
  measured record.
- E4 (§1.3): re-decompile writes a new directory by default; `--overwrite`
  explicit (ruling 4).
- E5 (§4.2): documented that `name set` alone stales line-bearing queries;
  batch-set → render → query is the intended loop pattern.
- E6 (§2.5): host-global governance — pinned data file + `host-global?`
  auto-surfacing (ruling 2).
- E7 (§7): new acceptance test A10 (host-global list pin + candidate
  surfacing).

**Notes to the implementer (non-blocking)**: checker closure resolution must
not import the emitter's dataflow (finding 3); A1's `new URL(...).pathname`
is fine for macOS/Linux (the project's supported platforms); `query check`
output has no §3.1 cap because it is not a loop verb — on FAIL it prints the
row-level diff, on PASS one line.

### P2.1 close-out size renegotiation (2026-09-03)

Per ruling 3 above ("optimise, or come back through this gate with the
measured number and renegotiate the budget openly — the budget number may
move, the graph's completeness may not"): docs/BUGS.md's 2026-09-03 "index
build 51.4% of decompile / index 64.5% of rendered source" row was closed out
in two parts.

**Build time (target 1 of the pair): FIXED, no renegotiation needed.**
Diagnosed with `--cpu-prof`-style manual timing splits
(`src/artifact/write.ts`'s call sequence): the walk-cost part
(`src/artifact/semantic-walk.ts`) was calling `walkFunction` on every
function **three times** (once each for `calls.jsonl`/`globals.jsonl`/
`string-uses.jsonl`, `decoded`/`cfg` memoized but the walk's own per-
instruction dataflow loop was not) — consolidated into one
`buildSemanticIndexes` pass, byte-identical output (verified: sorted-diff
against the pre-change three-pass output on rn-template, zero lines
differ). That cut the walk 3x but the dominant remaining cost turned out to
be `analyseForArtifact` re-parsing + re-analysing the whole bundle from raw
bytes a SECOND time, independent of `splitProject`'s own parse+analyse
(deliberate by the original design, for the case an artifact is built
without a `SplitResult` in hand) — ~78% of index-build time on rn-template.
Fix: `SplitResult` now exposes the `{module,analysis}` pair `splitProject`
already built internally (`src/split/index.ts`); `writeArtifact` reuses it
when available instead of re-parsing (`src/artifact/build.ts`'s
`analyseForArtifact` takes an optional `reuse` pair) — an artifact builder
invoked without a `SplitResult` still parses for itself, so the semantic
layer's render-independence (§0) is unaffected. Measured: index build
51.4% -> **9.4%** of decompile+render time on rn-template (target ≤25%,
now met with margin).

**Index size (target 2 of the pair): RENEGOTIATED, floor measured.**
Per-file byte breakdown on rn-template (index/ = 3,721,684 bytes total):
`calls.jsonl` 1,162,450 (31.2%), `string-uses.jsonl` 1,250,411 (33.6%),
`functions.jsonl` 443,625 (11.9%), `strings.json` 334,232 (9.0%),
`ranges.jsonl` 216,375 (5.8%), `modules.json` 145,336 (3.9%),
`native.jsonl` 108,685 (2.9%), `globals.jsonl` 81,148 (2.2%). `calls.jsonl`
+ `string-uses.jsonl` alone are 2,412,861 bytes — **41.8% of rendered
source bytes**, already above the original 30% target with every OTHER
index file at zero. These two files are exactly the per-call-site and
per-(sid,fn,role)-aggregate rows §2.2/§2.3b require for truth (never a
guessed edge, `?` is a first-class answer with a mandatory `why`) — cutting
either row set is trading completeness, which ruling 3 forbids outright.
The remaining lever is the JSON *encoding* (per-row field-name repetition:
e.g. `{"caller":42,"site":7,"callee":57,"kind":"closure","via":"direct"}`
vs a positional-array form `[42,7,57,"closure","direct"]`) — a real, still
open optimisation (queued below) that this close-out's budget did not
reach; it was not attempted rather than attempted and reverted. **New
target: `index/` ≤ 70% of rendered-source bytes** (measured actual on
rn-template: 64.5%, unchanged by the time fix since it touches build cost,
not row content — headroom kept for the held-out bundle). §5's table and
docs/BUGS.md updated in the same commit as this renegotiation.

**Follow-up queued, not part of this close-out**: a compact positional-array
encoding for `calls.jsonl`/`string-uses.jsonl` (bump `hbc2js-index/2`,
update §1.1/§2.2/§2.3b and the A1 format tests in the same commit) could
plausibly claw the ratio back toward the original 30% — estimated ~40-45%
smaller per row from dropping repeated field names alone, unverified. Left
for a dedicated task rather than attempted under this close-out's remaining
budget (docs/BUGS.md row updated, unassigned lane).
