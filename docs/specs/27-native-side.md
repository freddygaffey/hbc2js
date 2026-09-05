# 27 — Native-side capability: APK native ingestion + JS<->native linkage (spec)

Status: **written 2026-09-05 (Claude Opus 5, lean spec worker)**, behind the
decision-8 spec+review gate (researched, acceptance tests for landing 1 shipped
with the spec, before implementation). Owner priority: the top post-UI item on
`docs/specs/hunt-tooling-backlog.md` (gap #1) and the unique edge Fred named:
*"the CryptoModule seam finding needed both JS + native halves, and it is the
path to a rebuildable app."*

Reading list (open only what a landing you implement names):
`docs/specs/hunt-tooling-backlog.md` §1 (the gap), `docs/specs/cross-platform-
reconstruction-IDEAS.md` (the reconstruction thread), `docs/specs/10-artifact-
format.md` §1 (artifact layout), §2.5 (`native.jsonl`, the JS-side boundary
this spec joins to), §4 (truth guarantees), `docs/specs/11-project-store.md` §1.5
(findings), §4 (evidence rules), `src/artifact/native.ts` +
`src/artifact/native-boundary-packages.ts` (the JS-side bridge surface — already
landed, build on it, do not redo it), `src/deps/apk.ts` (the existing APK
evidence reader this spec grows from), `src/deps/classify.ts` (first/third-party
classification), `docs/DECISIONS.md` D16 (corpus rules), D17/D17a/D19 (deps +
native-module identification channel).

> **Provenance note.** Candidate #8 on `docs/QUEUE.md` (the JS-side
> `bridge-module` surface) is **DONE** — `docs/BUGS.md` 2026-09-02 row, FIXED
> 2026-09-04, via `src/artifact/native-boundary-packages.ts` +
> `src/artifact/native.ts` (`nativeBoundaryModuleIds` / `buildNativeIndex`).
> This spec consumes that surface; it never re-derives it.

---

## 0. Where this sits in the pipeline

Today hbc2js sees exactly one half of an app: the Hermes JS bundle. An RN app is
JS **plus** a native side the decompiler never touches — `react-native-config`
`.env` values baked into `strings.xml`/`BuildConfig`, and the first-party native
modules (`au.gov.nsw.service.react.modules.*` on NSW: Crypto, RootDetection,
PlayIntegrity, Screenshot, Auth0Guardian, ...). Two capabilities the owner
named, both delivered into the **same project** as the JS artifact:

- **(A) Native ingestion.** Read `classes.dex`, `AndroidManifest.xml`,
  `resources.arsc`, and assets out of the APK into artifact tables under
  `<artifact>/native/`, beside the existing `index/` (spec 10 §1). Read-only,
  local-only, never fabricated (spec 10 §4 truth rules apply unchanged).
- **(B) JS<->native linkage.** Join the JS-side boundary rows
  (`native.jsonl`'s `bridge-module` / `host-global` surface, `NativeModules.<X>`
  string-uses, TurboModule spec calls) to the native implementations
  (`@ReactModule(name=...)` / `getName()` module names, `@ReactMethod` methods,
  TurboModule codegen spec classes). Output: `native/seams.jsonl`, one row per
  seam citing **both** sides' evidence. Powers the seam bug-hunting edge and
  cross-platform reconstruction (spec `cross-platform-reconstruction-IDEAS.md`).

The artifact is the join point. `manifest.json` (spec 10 §1.2) gains a `native`
provenance block; native rows use `native:`-namespaced binding keys that live in
the same id space the project store (spec 11) annotates and the MCP/UI read.

**Scope discipline.** Android only. iOS (`RCT_EXPORT_MODULE` / Mach-O) is a
documented future (§L9), no work now — Android is the canonical donor
(unencrypted; custom native is DEX, not iOS machine code —
`cross-platform-reconstruction-IDEAS.md` "Direction asymmetry").

---

## 1. The DEX / binary-XML reader — recommendation and licence check

The single design decision this spec turns on: how do we read `classes.dex`,
binary `AndroidManifest.xml`, and `resources.arsc`?

### 1.1 Options evaluated (on paper; no tool installed)

| Option | What it gives | Cost / risk |
|---|---|---|
| **(a) Own minimal read-only TS parser** of DEX header + string/type/proto/field/method id tables + `class_def` + annotation tables; own AXML + ARSC chunk decoders | Everything the linkage needs: class names, method names + signatures, `@ReactModule`/`@ReactMethod` annotations, `static final` string constants, manifest components + intent filters, `strings.xml` key/value pairs | We author + maintain the parser. Does **not** decode method *bodies* (smali bytecode) — a value computed inside a method (not a `static final` constant) is out of reach without a bytecode reader |
| **(b) Shell out to baksmali** (Apache-2.0) | Full smali incl. method bodies; grep-able text | Requires a JVM + the jar on the box; not present on the gate; heavyweight per-invocation |
| **(c) Shell out to apktool** (Apache-2.0) | smali + decoded resources + manifest in one shot | JVM; bundles smali/baksmali; heaviest; primarily a resource/manifest decoder |
| **(d) Shell out to jadx** (Apache-2.0) | Decompiled Java (nicest to read) | JVM; slowest; overkill for name/annotation extraction |

### 1.2 Recommendation — own minimal parser primary, external tool opt-in oracle

**Write our own minimal, read-only TS parser** for DEX, AXML and ARSC as the
**primary** path, and keep **baksmali** (Apache-2.0) as an **opt-in external
accelerator/oracle** on `PATH`, exactly the pattern `src/deps/apk.ts` already
uses for `aapt` and `tools/hermesc` uses for the compiler. Reasons, in order:

1. **Zero-runtime-deps is a hard invariant here.** `package.json` has **no
   `dependencies` key** (confirmed: only `devDependencies` typescript +
   @types/node); `files` ships `dist` + the sigdb only. A JVM-based tool as a
   *required* dependency would break "works on macOS and Linux with no native
   deps" (CLAUDE.md) for the core path. An external tool may only ever be an
   optional accelerator, never on the critical path.
2. **The facts linkage needs are in the DEX metadata tables, not the
   bytecode.** RN module registration is discoverable from the string pool,
   type/method id tables and annotation tables alone: a module's public name is
   an `@ReactModule(name="X")` annotation value or the `String` returned by
   `getName()` (a `const-string` in a tiny method — recoverable as a string
   pool + method-name join, or via the optional oracle); `@ReactMethod` marks
   exported methods; TurboModule spec classes are `Native<X>Spec` subclasses of
   codegen base types. All of these live in tables our minimal parser reads
   without a single instruction decoded.
3. **DEX / AXML / ARSC are small, stable, publicly-documented chunk formats.**
   We derive the layout from the public Android open-source **format
   documentation** (the `dex-format` / `axml` / `arsc` chunk specs) — the same
   posture as deriving opcode tables from Hermes' MIT `BytecodeList.def`, never
   from an AGPL tool. **No code is copied from any GPL/AGPL DEX tool.** (There
   is no AGPL DEX tooling in play here regardless; the caution mirrors the
   hermes-dec rule.)
4. **The one gap is honest and bounded.** A value computed in a method body
   (not a `static final` constant) — e.g. a `.env` key assembled at runtime — is
   *unresolved* by the minimal parser. Truth rule: it stays unresolved (a
   `native/strings.jsonl` row with no binding, never a guess), and the optional
   baksmali oracle (or a future minimal DEX-bytecode reader, §L9) is the
   documented way to resolve it. We never fabricate a method-body fact.

### 1.3 Licence check (all permissive; none vendored into runtime)

| Artifact | Licence | Use |
|---|---|---|
| Android **format docs** (dex-format, AXML, ARSC) | AOSP docs (Apache-2.0 project) | Derive layout from; author our own parser |
| **baksmali / smali** | Apache-2.0 | Opt-in external oracle (`PATH`), never vendored |
| **apktool** | Apache-2.0 | Opt-in alternative for resources/manifest |
| **jadx** | Apache-2.0 | Opt-in, "read the Java" convenience only |
| **aapt / aapt2** (Android SDK build-tools) | Apache-2.0 | Already used by `apk.ts`; kept |

All four external tools are Apache-2.0 — safe to shell out to as an **opt-in
toolchain** (documented in `docs/TOOLCHAIN.md`, like `tools/get-hermesc.sh`).
None may be added to `dependencies` or vendored; the core path must run with
none of them present.

### 1.4 Refusal posture (truth rule, restated for native)

- A table row is emitted **only** from bytes actually present. A missing
  `resources.arsc`, an encrypted/obfuscated DEX, a value that lives in a method
  body the minimal parser can't read → the fact is **absent or marked
  `unresolved`**, never inferred. Mirrors spec 10 §4.2 (staleness is an error,
  never a wrong answer) and the `native.jsonl` "never a guessed row" rule.
- Every native artifact file carries the same schema header as `index/` files
  (`{"schema":"hbc2js-native/1","kind":"...","source":"dex|axml|arsc|zip"}`); an
  unknown major schema is refused, not guessed (spec 10 §1.1).

---

## 2. Landing sequence

**Nine landings**, ordered so contract-affecting work (the reader + schema, then
the JS-side join key) lands before anything is written against it, then
user-visible value, then reconstruction, then the risky/future halves.

Model: **Opus** for the two hard readers/joins (L1 the DEX/AXML/ARSC reader, L3
the linkage join — both are format/dataflow work); **Sonnet** for mechanical
landings against the settled contract. Every landing ships tests + the docs it
changes + a `docs/AGENT-LOG.md` line + a `docs/test-count-baseline.json` bump
re-derived from committed HEAD (CLAUDE.md), and every fixture that ever leaves
the gate carries a `docs/BUGS.md` row + owner (CLAUDE.md testing rules).

**Acceptance-test convention.** Each landing names its test files and the exact
test titles. This spec ships the **L1** files (skipped, `{skip:"spec 27 L1
acceptance — unimplemented"}`, marked `// ACCEPTANCE: spec 27`); later landings'
implementers create their files and bump the baseline once, per the spec-26
convention. All tests are **property-based** (round-trip / invariant / cite-both-
sides), never a golden-output compare against a shared fixture (CLAUDE.md).

| # | Landing | Model | Depends on | Output |
|---|---|---|---|---|
| L1 | DEX + AXML + ARSC + asset **reader** and its artifact tables | **Opus** | — | `native/{classes,methods,strings,resources,assets}.jsonl`, `native/manifest.json` |
| L2 | RN module-registration extraction (`@ReactModule`/`getName`/`@ReactMethod`/TurboModule specs) | Sonnet | L1 | `native/react-modules.jsonl` |
| L3 | JS<->native **linkage** join | **Opus** | L1, L2 | `native/seams.jsonl` |
| L4 | First-party vs third-party labelling | Sonnet | L2 | label column on L2/L3 rows |
| L5 | MCP + ui-server read verbs; UI Context-pane "native impl" link | Sonnet | L3 | `query native ...`, `GET /api/native/...` |
| L6 | `.env` recovery from `strings.xml` / `BuildConfig` | Sonnet | L1 | `native/env.jsonl` + `.env` in reconstruction |
| L7 | Known-lib native shortcut; merge native dep channel with `deps` | Sonnet | L2, L4 | merged dependency list (two channels) |
| L8 | Rebuildable-project emit incl. native (custom-module TODO stubs) | Sonnet | L6, L7 | project emit hook |
| L9 | Documented futures: iOS Mach-O, DEX method-body reader, resynth custom native | — | — | docs only |

---

### L1 — The DEX / AXML / ARSC / asset reader + artifact tables · Opus

**Why first:** everything downstream reads these tables; the contract must be
right before L2/L3 are written against it. This is the acceptance-tested landing
shipped with this spec.

**Scope.**
1. `src/native/dex.ts` — a read-only DEX parser: header (magic `dex\n035..041`,
   endianness tag, checksum/sha1 are **read and reported, never verified-as-
   gate**), then the string_ids / type_ids / proto_ids / field_ids / method_ids
   tables and `class_def_item`s incl. `annotations_directory` (class + method
   annotations). Multi-dex: enumerate `classes.dex`, `classes2.dex`, ... Exposes
   a typed `DexImage { strings, types, protos, fields, methods, classes,
   annotations }`; does **not** decode method bodies (§1.2 gap).
2. `src/native/axml.ts` — a minimal binary-XML (AXML) chunk decoder for
   `AndroidManifest.xml`: string pool + resource-map + start/end element +
   attribute chunks → a small element tree. Replaces `apk.ts`'s heuristic
   raw-string scan on the manifest with a real decode when the chunk magic is
   present; falls back to the existing heuristic (and says so in `notes`) when
   it is not.
3. `src/native/arsc.ts` — a minimal `resources.arsc` decoder: the global string
   pool + package/type/entry tables, enough to resolve `@string/...` references
   and dump `res/values*/strings.xml` key->value pairs (the `.env` channel,
   §L6). Values that are references to other resources stay as references
   (`@ref`), never flattened by guessing.
4. `src/native/ingest.ts` — the orchestrator: given an `.apk` (or an extracted
   dir), unzip-list (reusing `apk.ts`'s `unzip` helpers), read each source, and
   write the tables below into `<artifact>/native/`. Wires a `native` block into
   `manifest.json` (source file shas, dex count, tool used or "own-parser",
   `notes`).
5. `tools/artifact/check-native.ts` — a separate re-walker (the spec 10 §4.1
   discipline: a second simple reader, not the builder called twice) that
   re-derives the row counts from the raw bytes and diffs; wired to `test:all`
   on the fixture, runnable as `hbc2js query check --native`.

**Artifact tables (contracts).** All JSONL, schema header first line, sorted by
primary key so P2.5 diffs are line diffs (spec 10 §1.1). Native binding keys:
`native:type:<Lfqcn;>`, `native:method:<Lfqcn;>-><name>(<proto>)`,
`native:str:<dexIndex>`, `native:res:<pkg>/<type>/<name>` (namespaced siblings
of `src/name-overlay/id.ts`'s `fn:`/`reg:` keys — the implementer adds a
`nativeKey()` helper there, not a reimplementation).

- `native/classes.jsonl` — `{key:"native:type:Lcom/x/Foo;", name, super, access:
  ["public","final",...], sourceFile:string|null, annotations:[...], dex:0}`.
  `sourceFile` only when DEX debug info carries it; else `null`.
- `native/methods.jsonl` — `{key:"native:method:...", class:"native:type:...",
  name, proto:"(Lcom/...;)V", access:[...], annotations:[{type,elements}]}`. One
  row per method; `@ReactMethod`/`@ReactModule` land in `annotations` verbatim.
- `native/strings.jsonl` — `{i:<dexStringIndex>, s:"..."}`: the whole DEX string
  pool, the raw evidence. Unresolved-as-linkage is the default state; never a
  guess about what a string "means".
- `native/resources.jsonl` — `{key:"native:res:pkg/string/api_url", value:"..."
  |{"ref":"@string/..."}, config:"default|xxhdpi|...", type:"string"}`.
- `native/manifest.json` — `{package, versionName, versionCode, permissions:[],
  usesSdk:{min,target}, components:[{kind:"activity|service|receiver|provider",
  name, exported:bool|null, intentFilters:[{actions,categories,data:[{scheme,
  host,pathPrefix}]}]}], notes:[]}`. `exported` is `null` (unknown) when the
  attribute is absent and no default can be soundly inferred — never guessed.
- `native/assets.jsonl` — `{path:"assets/foo.json", size, sha256, kind:"json|
  png|font|other"}`: **inventory only**. Contents of an asset are **never**
  copied into the artifact (D16 C5 / the "never publishes extracted content"
  rule in `apk.ts`); a `google-services.json`-style known config is flagged by
  path, its bytes are not read into a committed table.

**Files.** `src/native/dex.ts`, `src/native/axml.ts`, `src/native/arsc.ts`,
`src/native/ingest.ts`, `src/native/schema.ts` (row types), `src/name-overlay/
id.ts` (add `nativeKey`), `src/artifact/manifest.ts` (the `native` block),
`tools/artifact/check-native.ts`, `docs/specs/10-artifact-format.md` (a new
§2.8 pointer to this spec), `docs/TOOLCHAIN.md` (the opt-in baksmali/apktool
entry).

**Acceptance tests** (this spec ships them, skipped — `tests/gate/native/dex-
reader.test.ts`, `tests/gate/native/axml-arsc.test.ts`, `tests/gate/native/
ingest-tables.test.ts`; titles are the exact `test(...)` names):
- *dex: parses the fixture header, string/type/method tables at the documented
  offsets*
- *dex: recovers every class_def name and its superclass*
- *dex: surfaces a method's @ReactMethod / @ReactModule annotation with its
  element values*
- *dex: multi-dex (classes.dex + classes2.dex) yields the union with a stable
  `dex` column*
- *dex: a truncated / non-DEX blob is refused with a typed error, never a
  partial fabricated table*
- *axml: decodes AndroidManifest package + permissions + exported components
  from real binary-XML bytes (superset of apk.ts's heuristic)*
- *axml: a manifest with no `android:exported` attribute yields `exported:null`,
  never a guessed boolean*
- *arsc: resolves an `@string/x` reference to its default-config value*
- *arsc: a value that is itself a resource reference stays `{ref:...}`, not
  flattened*
- *ingest: writes native/*.jsonl with schema headers and primary-key sort*
- *ingest: check-native re-walk agrees with the builder row-for-row on the
  fixture*
- *ingest: assets.jsonl is inventory-only — no asset bytes appear in any table*
- *ingest: absent resources.arsc yields zero resource rows + a note, never an
  error and never a fabricated row*

**Fixture.** The hermetic synthetic APK of §3 (generated by a committed
generator, no JVM). `{skip}` lifts once L1 lands and the generator exists.

**Depends on:** nothing (grows from `apk.ts`).

---

### L2 — RN module-registration extraction · Sonnet

**Scope.** Over L1's `classes.jsonl` + `methods.jsonl` + `strings.jsonl`,
recognise React Native native-module registrations and write one row per
discovered module:
- **Old-architecture bridge modules.** A class extending `ReactContextBaseJava
  ModuleModule`/`BaseJavaModule` (by superclass name) whose module name comes
  from either an `@ReactModule(name="X")` class annotation **or** the string
  returned by `getName()` (recovered as the sole `const-string` such a one-line
  method returns — resolvable from the string pool when the method is trivial;
  otherwise `nameEvidence:"unresolved"` and the optional baksmali oracle path is
  noted). Exported methods = every method carrying `@ReactMethod`.
- **New-architecture TurboModules.** Codegen spec classes `Native<X>Spec`
  extending `ReactContextBaseJavaModule` + implementing a `TurboModule` marker,
  and the `<X>Package`/`getModule` registrations. The spec class's abstract
  methods are the exported surface.
- **`requireNativeComponent` / view managers.** Classes extending
  `(Simple|)ViewManager` whose `getName()` gives the JS component name — the
  native half of `requireNativeComponent("X")` / a Fabric component.
- **`NativeEventEmitter` names.** Event names surfaced from
  `@ReactMethod`-adjacent `sendEvent`/`Constants` where present; unresolved
  otherwise.

**Output.** `native/react-modules.jsonl` — `{key:"native:module:X", jsName:"X",
kind:"bridge|turbo|viewmanager", implClass:"native:type:...", methods:[{jsName,
nativeMethod:"native:method:..."}], nameEvidence:"annotation|getName-const|
unresolved", firstParty:null}` (`firstParty` filled by L4).

**Files.** `src/native/react-modules.ts`, `src/native/schema.ts` (+row type),
tests `tests/gate/native/react-modules.test.ts`.

**Tests** (property-based): *a bridge module's name is taken from
@ReactModule(name) when present*; *a bridge module with only getName()-const has
its name recovered and marked getName-const*; *@ReactMethod methods appear as
exported, non-@ReactMethod methods do not*; *a TurboModule spec class is
classified turbo with its abstract methods as the surface*; *a class that is not
an RN module produces no row*; *an unresolvable module name is `unresolved`,
never invented*.

**Depends on:** L1.

---

### L3 — JS<->native linkage join · Opus

**Why Opus:** it is the cross-artifact join that is the tool's unique edge, and
the place a wrong guess would be worst.

**Scope.** Join the **JS side** to the **native side** and emit one
`native/seams.jsonl` row per seam, each citing **both** sides' evidence. JS-side
signals (all already materialised — never re-derived here):
- `NativeModules.<X>.<method>` — from `index/string-uses.jsonl` (`"X"` and
  `"method"` strings) + `index/globals.jsonl`/`native.jsonl` (`NativeModules`
  host access) + `index/calls-resolved.jsonl` (the points-to receiver when
  available). The `<X>` string is the join key to L2's `jsName`.
- `TurboModuleRegistry.get("X")` / `getEnforcing("X")` — the TurboModule call
  shape, `"X"` from string-uses.
- `requireNativeComponent("X")` — join to an L2 `viewmanager` row.
- `new NativeEventEmitter(NativeModules.X)` + `addListener("event")` — event
  names to L2's event surface.

Match rule (truth-first): a seam row is emitted **only** when the JS-side module
name string equals an L2 `jsName`. A JS reference to a module with **no** native
impl in this APK is emitted as a seam row with `native:null` +
`status:"js-only"` (a real, valuable fact — an unresolved boundary, e.g. a
third-party module whose impl ships in a lib not in this DEX). A native module
with no JS reference is `status:"native-only"`. Never a fuzzy/substring match:
name equality or nothing.

**Output.** `native/seams.jsonl` — `{key:"seam:X.method", jsName:"X", jsMethod:
"method"|null, jsEvidence:{stringUses:[...ids], callSites:["fn:N",...],
resolved:"points-to|by-name|string-only"}, native:{module:"native:module:X",
method:"native:method:..."|null}|null, status:"linked|js-only|native-only",
firstParty:bool|null}`. Each row is independently checkable against the two
artifacts it cites (the acceptance invariant).

**Files.** `src/native/seams.ts`, `src/native/schema.ts`, tests
`tests/gate/native/seams.test.ts`.

**Tests** (property-based, cite-both-sides): *a linked seam's `jsEvidence` ids
resolve in string-uses.jsonl AND its `native.module` resolves in react-
modules.jsonl*; *a JS NativeModules.X with no native impl is `js-only` with
`native:null`, never dropped and never guessed*; *a native module never
referenced from JS is `native-only`*; *matching is exact-name — a `Crypto` JS
ref never links to a `CryptoStore` native module*; *the CryptoModule-shaped
fixture (a JS `NativeModules.Crypto.generateKey` + a native `@ReactModule(name=
"Crypto")` with `@ReactMethod generateKey`) produces exactly one `linked` seam
citing both halves* (the regression encoding the finding that motivated this
spec).

**Depends on:** L1, L2.

**Landed (2026-09-05).** `src/native/seams.ts` + `SeamRow` in
`src/native/schema.ts`; `native/seams.jsonl` (header `source:"join"`) is
written by `ingestNative` only when the same directory holds a JS artifact,
and is documented in docs/specs/10-artifact-format.md §2.8. Fixtures:
`tests/fixtures/constructs/66-native-module-seams` (JS half, every committed
bytecode version) + `tests/fixtures/native/seams.apk` (native half; the
L1/L2-pinned APKs are untouched). **One honest deviation, recorded in
docs/BUGS.md:** the JS tables carry no receiver for a host-object member
chain, so every row is `resolved:"string-only"` (`points-to`/`by-name` are
unreachable until a JS-side signal exists), and an unmatched `NativeModules`
member string is emitted `js-only` rather than dropped — over-reporting a
method name as a candidate module, never fabricating a link.

---

### L4 — First-party vs third-party labelling · Sonnet

**Scope.** Label every L2 module row and L3 seam `firstParty:bool`:
- **Third-party (high reliability):** the impl class package matches a known
  native-module package prefix (`com.oblador.keychain`, `com.reactnative
  community.*`, `com.swmansion.*`, `org.reactnative.*`, ...) — the near-100%
  native identification channel from `cross-platform-reconstruction-IDEAS.md`
  §"native libs have a SECOND channel". This list is a curated in-repo data file
  (`src/native/third-party-packages.ts`), same governance as
  `native-boundary-packages.ts` (appended only via a reviewed evidence-citing
  commit); it is **seeded from**, and cross-checked against, the deps signature
  DB (`tools/pkgsig`) so the two channels agree.
- **First-party:** the impl class package equals (or is under) the app's own
  package prefix from `native/manifest.json` (`package=au.gov.nsw.service...` ->
  `au.gov.nsw.service.*` classes are first-party). This is exactly how NSW's 9
  custom modules are identifiable.
- **Unknown -> `null`.** A package matching neither list is `firstParty:null`
  (unresolved), surfaced for the human, never guessed either way.

**Needs Fred:** the seed first-party heuristic (is "under the manifest package
prefix" the rule, or does Fred want an explicit allow/deny per app?) and the
initial third-party package list — see §5.

**Files.** `src/native/third-party-packages.ts`, `src/native/classify-party.ts`,
tests `tests/gate/native/classify-party.test.ts`.

**Tests:** *a class under the manifest package is first-party*; *a class under a
curated third-party prefix is third-party*; *a class under neither is null, not
forced*; *the curated list agrees with the deps sigdb where they overlap
(pinned)*.

**Depends on:** L2 (uses L1's manifest package).

---

### L5 — MCP + ui-server read verbs; UI Context-pane native link · Sonnet

**Scope.** Read-only surfaces over L1-L4, following the spec-10 §3 /
spec-17 token-cost discipline (each verb states its bound):
- CLI: `hbc2js query native modules` (list), `native module <X>` (one module +
  its methods + its seams), `native seams [--status linked|js-only|native-only]
  [--first-party]`, `native manifest`, `native resources --key <re>`.
- Service API on `ArtifactService`: `nativeModules()`, `nativeModule(x)`,
  `seams(filter)` — mirrors the verbs (spec 10 §3.2).
- MCP: `McpResources` read verbs mirroring the above (spec 17); a seam is a
  first-class read object so the LLM loop can pull "the native impl of this JS
  call" in one cheap call.
- `GET /api/native/modules`, `/api/native/module/:x`, `/api/native/seams`,
  `/api/native/manifest` on `src/ui-server`.
- UI: the Context pane gains a **"native impl"** row on any `fn:N` that
  participates in a seam — one click from a `NativeModules.X.method` JS call
  site to the native module/method (and its first/third-party label). Later
  landing note only: a dedicated Seams pane is deferred to a spec-26-style UI
  landing; L5 ships only the Context-pane link + the API.

**Files.** `src/artifact/service.ts`, `src/cli` (query subcommands),
`src/mcp/resources.ts`, `src/ui-server/routes.ts`, `ui/src/panes/ContextPane.
tsx`, `ui/src/api.ts`, tests `tests/gate/native/query-verbs.test.ts` +
`tests/ui-server/native-routes.test.ts` + `tests/ui-core/context-native.test.
ts`.

**Tests:** *`native module X` returns the module, its methods, and its seams in
one call*; *`native seams --status js-only` returns only unlinked JS refs*;
*the route refuses on a stale artifact (`E_STALE_INDEX`, spec 10 §4.2)*; *the
Context pane shows a native-impl row for a seam fn and nothing for a non-seam
fn*.

**Depends on:** L3.

**Landed (2026-09-05).** `ArtifactService.nativeModules()`/`.nativeModule(x)`/
`.seams(filter)`/`.nativeManifest()`/`.nativeResources(pattern)` in
`src/artifact/service.ts` (plus `.nativeImplFor(fn)`, the Context-pane's own
bounded-by-fn projection — not one of the four route names above but needed
so the pane never misses a seam past `seams`'s 100-row cap); mirrored on
`McpResources` (`src/mcp/resources.ts`), the CLI (`src/cli.ts`'s `native`
verb branch, disambiguated from the pre-existing `query native [--fn N]`
JS-host-surface verb by the first positional token), and
`GET /api/native/{modules,module/:x,seams,manifest,impl/:fn}`
(`src/ui-server/native.ts`, spliced into `routes.ts`'s `ROUTES` as
`NATIVE_ROUTES`). UI: `ui/src/panes/context-native.ts` (the pure label/
detail logic) + `ui/src/panes/RightPane.tsx`'s Context tab (not
`ContextPane.tsx` — no such file exists; the Context tab lives inside
`RightPane.tsx`'s `RightPanelBody`), `ui/src/contracts.ts`'s `NativeImpl`
type, `ui/src/api.ts`/`ui/src/mock.ts`/`ui/src/hooks.ts`'s `nativeImpl`/
`useNativeImpl`. Every reader is null/empty-tolerant (native/ is
optional-by-construction, §1.4); staleness needs no new check — `E_STALE_
INDEX` already fires at `ArtifactService` construction, before any native
verb runs.

---

### L6 — `.env` recovery from strings.xml / BuildConfig · Sonnet

**Scope.** `react-native-config` bakes `.env` into `res/values/strings.xml` (and
a `BuildConfig` class of `static final String` fields). Recover both channels
into `native/env.jsonl` and, in reconstruction (§L8), a `.env` file:
- From L1's `native/resources.jsonl`: string resources whose names look like env
  keys (all-caps + underscores) — surfaced, but **every** string resource is
  available; the env-key shape is a *filter/label*, not a gate.
- From L1's DEX: a `BuildConfig` class's `static final String` fields — the
  *field name* is in the field_ids table; the *value* is a `const-string` in
  `<clinit>` (a method body) — resolvable via the optional baksmali oracle or a
  future minimal `<clinit>` reader; **without** it the field name is emitted
  with `value:"unresolved"` (a real, honest partial — we know the key exists,
  not its value). This is the documented DEX-method-body gap of §1.2 in action.
- **Proven evidence bar** (`cross-platform-reconstruction-IDEAS.md`): the NSW
  `APIGEE_DOMAIN="https://api.g.service.nsw.gov.au"` lived in `strings.xml`, NOT
  the `.hbc` — so the `strings.xml` channel alone already recovers the headline
  case with the minimal parser (no oracle needed).

**Output.** `native/env.jsonl` — `{key:"API_URL", value:"..."|"unresolved",
source:"strings.xml|BuildConfig", resolvedBy:"own-parser|baksmali|none"}`.

**Files.** `src/native/env.ts`, tests `tests/gate/native/env.test.ts`.

**Tests:** *a strings.xml env key/value is recovered by the own parser
(APIGEE-shaped fixture)*; *a BuildConfig field with no oracle is `unresolved`
with its key present, never a guessed value*; *a non-env string resource is not
mislabelled as env*.

**What makes it recoverable / refusal:** `strings.xml` values -> always (plain
ARSC). `BuildConfig` values -> only with the oracle or a `<clinit>` reader;
otherwise key-only. Values assembled at runtime -> refused (unresolved).

**Depends on:** L1.

---

### L7 — Known-lib native shortcut; merge the native dependency channel · Sonnet

**Scope.** Implement the second, near-100% identification channel from the IDEAS
doc: native modules register with **literal package names** in DEX/manifest
(`com.oblador.keychain.KeychainPackage` -> `react-native-keychain`). Map L2's
third-party impl-class packages to npm package names (a curated
package-prefix -> npm-name table, seeded from and cross-checked against
`tools/pkgsig`), and **merge** that list with `src/deps`'s JS-fingerprint list,
de-duplicated, two evidence channels per row (`evidence:["native-package",
"js-fingerprint"]`). A native lib identified here that `deps` missed (the
`cross-platform-reconstruction-IDEAS.md` "deps recall is partial" tail) is added
with `channel:"native-only"`.

**Output.** Extends the existing `deps` report with a `nativeChannel` section;
no new top-level artifact file (the merge lands in the deps output the
reconstruction consumes).

**Files.** `src/native/native-deps.ts`, `src/deps/index.ts` (merge hook),
tests `tests/gate/native/native-deps.test.ts`.

**Tests:** *a known third-party native package resolves to its npm name*; *a
native-identified lib that JS-fingerprinting missed appears with
channel:native-only*; *a lib found by both channels appears once with both
evidence tags*; *a first-party (app-namespace) module is never emitted as an npm
dependency*.

**What makes it recoverable:** a literal, curated package prefix. Refusal: an
app-namespace or unknown package is not an npm dep (it is a custom module, §L8).

**Depends on:** L2, L4.

---

### L8 — Rebuildable-project emit including the native side · Sonnet

**Scope.** The reconstruction payoff (`cross-platform-reconstruction-IDEAS.md`
"Build steps to add"): when hbc2js emits a project tree from an APK, also emit:
- `.env` from L6's `native/env.jsonl` (recovered values only; `unresolved` keys
  emitted as commented TODOs with their evidence — never a fabricated value).
- `package.json` native dependencies from L7's merged list (third-party native
  libs — their native code ships with the library on `pod install`/gradle, so
  no reversing needed).
- A `native-todo/` folder with **one stub per first-party custom module** (L4
  `firstParty:true`): the recovered class/method **signatures** from L2 (a
  faithful interface skeleton) plus a `RESYNTHESIZE.md` per module listing what
  is known (the exported `@ReactMethod` surface + any recovered string
  constants) and what is not (method bodies — the honest gap). **No method body
  is fabricated.** This is the "flag custom native modules as TODO-resynthesize"
  step, made concrete and refusal-bounded.

**Files.** `src/native/reconstruct.ts`, project-emit hook in the existing
app-gen path, tests `tests/gate/native/reconstruct.test.ts` +
`tests/appgen/native-reconstruct.test.ts`.

**Tests:** *a recovered .env value is emitted; an unresolved key is a commented
TODO with evidence, not a value*; *a third-party native lib is a package.json
dependency, not a stub*; *a first-party module is a native-todo stub with its
method signatures and no fabricated body*; *the emitted project's package.json
lists every merged native dep exactly once*.

**Depends on:** L6, L7.

---

### L9 — Documented futures (docs only)

No code. Records, in this spec and cross-referenced from `docs/DECISIONS.md`,
the three deferred capabilities with their evidence bars and refusals:

1. **iOS Mach-O / `RCT_EXPORT_MODULE` / `RCT_EXPORT_METHOD`.** iOS native modules
   register via ObjC macros compiled into a Mach-O binary — machine code, not
   DEX. Recovering method names is possible from the `__DATA` section's ObjC
   metadata + `RCT_EXPORT` registration structs; recovering *behaviour* is full
   binary RE. Deferred entirely; Android is the donor
   (`cross-platform-reconstruction-IDEAS.md` "Direction asymmetry"). No Mach-O
   work now.
2. **DEX method-body reader.** A minimal DEX bytecode reader (the format's
   ~230 opcodes) would resolve `getName()`-const module names, `BuildConfig`
   `<clinit>` values, and simple constant flows without the baksmali oracle,
   closing the §1.2 gap for the core path. Scoped as its own spec when a hunt
   needs a value that only lives in a method body and no oracle is available.
3. **Resynthesis of custom native behaviour.** Turning a recovered smali method
   body into target-platform source (Kotlin->Swift) is code translation, not
   ingestion — the only true entropy gap (`cross-platform-reconstruction-IDEAS.
   md` "Verdict"). L8 ships the *interface* skeleton + evidence; automated body
   translation is out of scope and would be LLM-assisted at best. Refusal:
   hbc2js never emits a fabricated method body.

---

## 3. Test-fixture plan (how we get a legitimate APK to test against)

**The hard constraint (CLAUDE.md / D16 C5):** **no real-world app bundle or APK
(Service NSW, any proprietary app) may ever be committed** — hashes only, in
`local-corpus/MANIFEST.json`, gitignored bytes. So the gate fixture must be
synthetic and our own.

**Primary (gate, hermetic, no JVM): a committed generator that emits synthetic
APK bytes.** `tools/native-fixture/gen.mjs` writes a tiny `.apk` (a zip) whose
`classes.dex`, `AndroidManifest.xml` (binary AXML), `resources.arsc`, and a
couple of `assets/` files are produced **by hand from the format specs** — we
are both the producer and the consumer of the parser, so the fixture is a
*known-good byte sequence we author*. It contains, deliberately:
- one first-party bridge module `com.example.app.CryptoModule` with
  `@ReactModule(name="Crypto")` + a `@ReactMethod generateKey` (the
  CryptoModule-shaped regression for L3),
- one third-party-shaped module under `com.oblador.keychain` (for L4/L7),
- one TurboModule spec class (for L2),
- a `strings.xml` with `APIGEE_DOMAIN="https://api.example.test"` and a
  `BuildConfig` class (for L6),
- a manifest with a package, a permission, an exported activity with a deep-link
  intent-filter, and one component with no `exported` attribute (for the
  `exported:null` test).
The fixture is regenerated by `npm run fixtures` (a `native` mode), committed as
a **small** (`< ~20 KB`) `.apk` under `tests/fixtures/native/`, and its sha is
pinned. Because we author the bytes, the parser round-trip (generate -> parse ->
assert the known values) is the property test, and the fixture is unquestionably
ours to commit.

**Faithfulness cross-check (once, off-gate, on `deb`):** the generator's output
is validated against a real tool (`aapt dump`, `baksmali`) on `deb` **once** to
prove our hand-authored bytes match what a real toolchain accepts, and that
cross-check is recorded in `docs/reports/` — but the tool is **not** a gate
dependency. If the synthetic generator ever proves too fragile, the fallback is
to build the fixture with the **smali assembler** (Apache-2.0) in
`tools/native-fixture/` as an opt-in build step (like `tools/get-hermesc.sh`),
still emitting a tiny committed `.apk` — never a real app.

**Larger realistic fixture (sweep-tier, INCONCLUSIVE-when-absent):** a real RN
template app (the committed `rn-template` source) with one added custom native
module, built to an APK on `deb` with the Android SDK. Too large to commit (tens
of MB) — kept in `local-corpus/` (gitignored), sha in `MANIFEST.json`, exercised
only in the sweep tier when present (mirrors D16 C5 / D16a on-device tiering).
This proves the parser on real-compiler DEX; the gate never depends on it.

Every fixture that gates carries a `docs/BUGS.md` row + owner if it is ever
excluded from a tier (CLAUDE.md testing rules); the synthetic fixture is a
first-class gate input, not an exclusion.

---

## 4. Truth guarantees (native-specific, extending spec 10 §4)

1. **Every native row is a pure function of (input bytes, parser).** The
   `check-native` re-walker (§L1.5) re-derives counts from bytes and diffs;
   wired to `test:all` on the synthetic fixture. A mismatch is a FAIL.
2. **Unresolved stays unresolved.** No method-body value is guessed; a
   `getName()`/`BuildConfig` value the minimal parser can't read is
   `unresolved` with the key/field preserved. A JS module with no native impl is
   `js-only`, not dropped; a native module with no JS ref is `native-only`.
3. **Exact-name join only (L3).** No substring/fuzzy module matching — name
   equality or a `js-only`/`native-only` row. A false seam is worse than a
   missing one (the edge is bug-finding; a fabricated seam is a fabricated bug).
4. **Never publishes extracted content.** Asset/resource bytes are inventoried
   (path/size/sha), never copied into a committed artifact; local-only,
   upload-never (D16 C5, `apk.ts`'s standing rule).
5. **Staleness is an error** (spec 10 §4.2): the `native` manifest block records
   the source shas; a query refuses on a drifted native artifact rather than
   answering from stale tables.

---

## 5. Needs Fred

1. **DEX-reader decision ratification.** §1.2 recommends *own minimal TS parser
   primary + baksmali (Apache-2.0) opt-in oracle*. Confirm (vs "just require
   apktool/jadx"); this is the load-bearing architecture choice. If confirmed it
   is recorded as a new `docs/DECISIONS.md` entry.
2. **First-party heuristic (L4).** Is "any class under the AndroidManifest
   `package=` prefix is first-party" the rule, or do you want an explicit
   per-app allow/deny (e.g. a project setting listing the app's own namespaces)?
   NSW's `au.gov.nsw.service.*` is the motivating case.
3. **Third-party native-package seed list (L4/L7).** Approve the initial curated
   `src/native/third-party-packages.ts` (seeded from `tools/pkgsig`) — additive,
   evidence-cited thereafter, same governance as `native-boundary-packages.ts`.
4. **Opt-in toolchain policy.** OK to document baksmali/apktool/jadx (all
   Apache-2.0) in `docs/TOOLCHAIN.md` as optional accelerators (never vendored,
   never a core dependency), mirroring `tools/get-hermesc.sh`?
5. **UI seam surface (L5, look).** The Context-pane "native impl" link is
   specified; a dedicated Seams pane is deferred to a spec-26-style UI landing —
   confirm that ordering (link now, pane later) and any art-direction.
6. **Sweep-tier real APK on deb (§3).** Approve building the RN-template+custom-
   module APK on `deb` (Android SDK), kept in `local-corpus/` (gitignored, sha
   in MANIFEST), for the INCONCLUSIVE-when-absent faithfulness test.

---

## 6. Decision-8 quadruple (metric / target / method / held-out)

- **Metric.** Native seam recall + precision on the synthetic fixture (every
  known JS<->native pair linked; zero fabricated seams), and `.env` recall on
  the `strings.xml` channel.
- **Target.** 100% of the fixture's authored seams `linked`; 0 fabricated;
  `strings.xml` env values 100% (they are plain ARSC); `BuildConfig` values
  key-recall 100%, value-recall gated by oracle availability (honest partial).
- **Method.** The `check-native` re-walk + the property-based acceptance tests;
  no golden-output compare (CLAUDE.md).
- **Held-out.** The sweep-tier real RN-template APK on `deb` (§3) — the parser
  proven on real-compiler DEX it never saw during development.

---

## 7. Non-goals (v1)

- iOS / Mach-O anything (§L9).
- DEX method-body / smali instruction decoding on the core path (optional oracle
  only; §1.2, §L9.2).
- Automated resynthesis of custom native behaviour (§L9.3) — L8 emits interface
  skeletons + evidence, never bodies.
- Modifying/repackaging an APK — read-only, always (D16 C5).
- Committing any real app's APK/bundle/assets — hashes only, ever (CLAUDE.md).
