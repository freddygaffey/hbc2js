# Hunt-driven tooling backlog — build AFTER the Stage-3 UI (Fred 2026-09-04)

The cycle: hunt real apps → hit a tool limitation → build it into the tool → hunt
further with the improved tool → repeat until an app is fully reversed → then more
apps → tooling is "done". Everything here is a gap a REAL NSW hunt exposed. Fred:
UI (Stage 3) first, THEN these.

## Tool gaps found (priority order)
1. **Native-side ingestion + JS↔native linkage (biggest).** App = JS + native side
   the Hermes decompiler never sees: react-native-config `.env` (BuildConfig.smali/
   strings.xml — e.g. APIGEE_DOMAIN="https://api.g.service.nsw.gov.au") + 9 first-party
   native modules (au.gov.nsw.service.react.modules.* — Crypto, RootDetection,
   PlayIntegrity, Screenshot, Auth0Guardian…). ADD: ingest APK native (smali/DEX +
   resources + manifest + assets) into ONE project; map `NativeModules.<X>.<method>`
   JS call sites ↔ native smali impl; label first-party vs third-party. Powers seam
   bug-finding (the unique edge) AND cross-platform reconstruction
   (cross-platform-reconstruction-IDEAS.md). PROVEN VALUE: the CryptoModule finding
   (software RSA key exported to JS + persisted) required BOTH halves.
2. ~~**`query string-uses <id>` verb.**~~ **DONE** (`453f6ad`): `query string-uses <sid>
   [--fn N] [--all]` (spec 10 §3.1, spec 17 §14.5) returns the instruction-level use
   SITES on demand — `fn:N fnName pc:P opcode role module:M`, sorted `(fn, pc)` —
   by re-walking the candidate function(s) with the same classifier that built
   `string-uses.jsonl` (`src/artifact/semantic-walk.ts`'s `walkFunction`/`bumpString`,
   given an optional `onSite` hook). Artifact format unchanged; live verb, needs `--hbc`.
   `tests/gate/artifact/string-uses.test.ts`.
3. ~~**Scoped single-function readable decompile.**~~ **LANDED 2026-09-04**
   (docs/DECISIONS.md D25): `hbc2js decompile <bundle.hbc> --fn N` +
   `decompileFunction(bytes, N, opts)` (`EmitOptions.onlyFunction` on the same
   `emitModule`). Renders fn N and its nested closures, placed as the whole-module
   render would place them, byte-identical to N's slice of the full render
   (`tests/gate/emit/scoped-decompile.test.ts`). NSW: ~3.4 s (only ~25 ms of it is
   N's own structure+emit; the rest is the unavoidable global parse+analysis+env
   graph) vs the whole bundle's minutes/timeout — a >25× win, and the cheap
   per-lead / LLM-loop context this item wanted. Residue: the fixed ~3.35 s global
   cost (env graph + placement are inherently whole-module) is not scoped away.
4. **xref robustness on dynamic dispatch.** who-calls/calls-from return total:0 on
   heavy RN dynamic dispatch (computed-callee). Surface the limitation clearly; longer
   term recover indirect edges via dataflow/taint.
5. **Artifact↔source-tree drift = CORRECTNESS.** Fresh artifact had modules the older
   on-disk tree lacked → a stale tree misses real endpoints. Fix = spec 18 (hash-lock/
   rebuild/verify), already its own item; listed here as evidence only.

## What DID shine (keep/lean on)
`query module <mod>` (deps + sole consumer in one call, beat grep); string-grep for
endpoint discovery; deps confirmedDeps as the API/host map seed.

## Round 2 tool-gaps (overnight hunt, 2026-09-04 — 4 directions)
**DOMINANT (hit in every direction — promote to #1): PARTLY CLOSED 2026-09-05.**
`who-calls`/grep can't resolve callers of `require(list[N]).method(...)` dynamic
dispatch — this app's DOMINANT calling convention, not an edge case. Blocked
confirming B1 licence-link body, D3 PIN→jsrsasign wiring, A4 Auth0 reachability.
FIX = a points-to / dataflow pass that resolves `require(N)` even when N is
register/list-indexed.
- LANDED (cheap half): `who-calls-by-name` — a by-NAME superset, spec 17 §14.1.
- LANDED (the residue): the points-to pass, spec 17 §14.4 — resolves the
  RECEIVER, so the edge is real and module-scoped (`index/calls-resolved.jsonl`,
  `confidence:"points-to"`). NSW: 6,789 resolved edges, 2,629 distinct callers,
  86 functions lifted out of `who-calls total:0`; rn-template: 934 edges / 208
  callers.
- STILL OPEN (honest): the pass refuses rather than guesses, so a receiver held
  across a branch, an `_interopRequireDefault` wrapper, or a babel
  `exports.default = void 0` prologue still yields no edge — 152/1,086 (rn-template)
  and 5,183/11,972 (NSW) proven receiver+name sites have no provable target
  (docs/BUGS.md 2026-09-05 rows). The three named leads should be re-run against
  the new edges before this gap is called closed.

New verbs/capabilities the hunt wanted:
- ~~`endpoint-tables` / object-literal-group discovery by key-pattern (PATH_*)~~ —
  **LANDED 2026-09-04 as `query object-tables`** (spec 10 §3.1, spec 17 §14.2;
  `src/artifact/object-tables.ts`). One `NewObjectWithBuffer*` scan of the whole
  bundle, filterable by `--key`/`--value` regex, `--min-props`, `--string-ratio`,
  `--module`, `--min-matched`. On NSW both endpoint tables lead
  `--value '^/' --min-props 4` (162 hits, ranked by how much of each table the
  query hit), and `--min-matched 4` narrows it to exactly those two — including
  the `LicenceAPIEndpoints` one the hunt found by lucky grep.
- HTTP-method-per-path + header-origin trace (is `X-AGENCY-CODE` client- or session-
  derived?) — currently pure manual reading.
- JSX-prop / named-component-config locator (`originWhitelist={…}` on WebView, RN
  `linking` config) — blocked confirming WebView origin restrictions + deep-link map.
- ~~AST pattern match "template literal containing a quoted string containing ${…}" — the
  WebView-injection anti-pattern (C1); would surface the bug class bundle-wide.~~ **DONE
  (2026-09-04)**: `query template-injections` (spec 17 §14.3, `src/artifact/
  template-injections.ts`) — bundle-wide, no decompilation; recognises both the
  `HermesInternal.concat` (template literal) and `Add`/`AddN`/`AddS` (`+`-chain) shapes.
  245 rows on Service NSW, ≈ 1 s scan.
- Generator/state-machine lowering reuses register names across case/yield boundaries
  (one `r3` = different things per case) → per-state rename in decompile/`query fn`.
- Storage-key classification (which keys route to encrypted-store vs plaintext
  AsyncStorage) in one pass, instead of key-by-key grep.

## Leads carried forward (for deeper hunts / live testing)
- B1 (TOP): POST /licences/link/{method} — does server verify holder before linking? (focus #2)
- A1: fine-detail/photo IDOR via bare {penaltyNumber} (no /me scoping on photos path)
- C1: unescaped name/licence data spliced into WebView injectedJavaScript (JS injection)
- L1 (prior): fake-enroll/delete MFA endpoints (highest a-priori if live)
- CryptoModule (prior): software RSA key exported to JS + persisted (offline forgery)

## Refinement (2026-09-04): cheaper fix for the dominant dispatch gap
The manual B1 resolution found the full points-to pass may be OVERKILL. This app's convention is
require-ONCE-into-an-env-slot then `<slot>.<exportName>`. So a **`who-calls-by-name <exportName>`
grep-based verb** across the split module tree resolves MOST hops WITHOUT register/list-index
points-to. Build the cheap name-based verb FIRST; reserve the full points-to pass for the residue.

**LANDED (2026-09-04):** `who-calls-by-name` shipped — `hbc2js query who-calls-by-name
<fn:N|--name X>`, `ArtifactService.whoCallsByName`, `McpResources.whoCallsByName`,
`GET /api/xref/who-calls-by-name`. `fn:N` proves the export names from bytecode (lazy ≤2-function
decode of the parent+factory, `src/artifact/exported-names.ts`) then scans other modules'
`property-get` uses; `--name X` scans one name. Rows carry `confidence:"by-name"` (never a resolved
edge); common/high-fan-out names return `ambiguous`. Spec: 17 §14.1. **Measured on rn-template: of
3,909 functions with `who-calls total:0`, 484 (12.4%) gain ≥1 by-name candidate.** RESIDUE for the
full points-to pass: the receiver's identity (which module a `property-get` actually targets) — the
by-name candidates are a superset (true caller + same-named-method / barrel / same-name-in-two-modules
false positives).

## SPEC 27 REAL-APK VALIDATION (2026-09-05) — 1 PASS-set, 1 hard bug
Ran native ingestion on the REAL NSW APK (base.apk) in a fresh project. Results:
- PASS: all 9 first-party modules detected + labelled first-party; .env recovery exact
  (APIGEE_DOMAIN=https://api.g.service.nsw.gov.au + 144 more keys); module extraction/labelling solid.
- **HARD BUG (L3 JS↔native seam join): 0/9 modules linked on the real bundle.** Root cause:
  `src/native/seams.ts` `anchorFns` requires NativeModules/TurboModuleRegistry/requireNativeComponent
  to appear as JS GLOBALS in index/globals.jsonl — true ONLY in the hand-written acceptance fixture
  (tests/fixtures/constructs/66-native-module-seams), NEVER in a real Metro bundle where these are
  require()-bound LOCALS. The evidence IS present (NativeModules+Crypto co-occur in fn:8871, matches
  manual NATIVE-SEAM.md) in index/string-uses.jsonl — the join just never reads it. FIX: seam join must
  resolve require-bound locals (use string-uses/points-to), not only globals. AND make fixture 66
  Metro-shaped (require-bound) so the regression test actually catches real bundles. Classic
  fixture-overfit / local-maximum — the "test on real apps" rule catching it again.
- TRAP: `hbc2js deps --out` on a STALE dist silently no-ops native ingestion (exit 0, no error, no
  native/ dir). Add a guard/warning. Bit the validation worker.
Full report: /Users/fred/nsw-hunt/NATIVE-INGEST-TEST.md

## Corpus sweep — timing + profiling (Fred 2026-09-05)
- **PER-SUB-STEP timing in tools/e2e/corpus-regression.mjs (Fred 2026-09-05: time each stage like `time <cmd>`, not just total).** Record ms for EACH sub-step separately per app: parse, decompile (readable passes), split, segregate, deps, artifact/native-ingest — plus fn count + bundle size. Localises WHERE time goes (the O(n^2) is in readable-passes specifically; split is cheap). The fix-cycle re-sweeps capture it automatically. Small enhancement + a test.
- **OUTLIER-TRIGGERED deep profiling (Fred 2026-09-05).** Compare each sub-step ACROSS apps; flag a sub-step that's an outlier (anomalously slow for that app's fn-count/size, or one stage dominating). ONLY THEN `--prof` deep-profile that specific slow sub-step on that specific app. Do NOT blanket-profile all 28 (expensive, redundant). Outlier detection localises the profile to exactly one stage × one app.
- **SLOW-FOR-SIZE = a perf BUG** → feeds the same triage→fix cycle. Recommendation for any slow app ties to the existing perf items: O(n^2) whole-file name-bookkeeping fix, single-threaded deps speedup, un-parallelised decompile (function-level pool). Timing across 28 apps PRIORITISES those three.

6. **Static SEAM REPORT — enumerate every point the bundle touches the outside world, BEFORE running it.**
   The single biggest lever the NSW hunt exposed. Getting that app running took ~38 sessions, and the
   overwhelming majority of that time was *discovering seams one runtime crash at a time*. Almost all of
   them were statically findable. A `hbc2js seams <bundle>` report would have collapsed weeks into one scan.
   Six classes, each with real evidence from the hunt:

   **(a) Metro-baked platform variants — the biggest single class.** Metro resolves RN core's
   `.android.js`/`.ios.js` sources at ORIGINAL build time and bakes ONE platform's copy into the bytecode.
   Run that bundle on the other platform and it requests native components/methods that do not exist there.
   FIVE separate instances in one app, each costing a debugging session: `legacySendAccessibilityEvent.android.js`
   (`typeViewFocused` off a UIManager constant iOS never provides); `AndroidSwipeRefreshLayout`;
   `RNSVGSvgViewAndroid` (vs iOS's `RNSVGSvgView`); `StatusBar.js` calling Android-only
   `StatusBarManager.setColor`/`setTranslucent`; `AndroidTextInput` (broke ALL text entry on iOS —
   renders but never becomes first responder). DETECTION: scan for `requireNativeComponent("<X>")` and
   native-method calls whose names carry a platform affix, and cross-reference module ids against RN's
   known platform-split core files. Output: "this bundle is Android-built; these N sites will fail on iOS",
   with the suggested alias target. Trivially scriptable, enormous payoff.

   **(b) Native-module seams.** Every `NativeModules.X` / `TurboModuleRegistry.getEnforcing("X")` call site
   is a mock point. Found the hard way: AsyncStorage, Firebase, crypto, device-init, `RNRandomBytes`
   (its `.seed` read unguarded at module top level, fatal), vision-camera, CookieManager, keychain,
   StatusBarManager. DETECTION: enumerate call sites, diff against what a given host provides, list gaps.

   **(c) Network/backend seams that gate rendering.** Screens that render chrome but an empty body because a
   fetch never resolves. Real examples: `fetchManagedContent` (module 725) gating four CMS screens;
   `getNotificationListAPI` (3031); `IssueReportingCategoriesCacheService.getCategories` (4059) — that one
   left Help & Support stuck on a spinner for ~28 sessions; Auth0 `refreshToken` (2212), the single call
   whose absence made a correct and an incorrect PIN indistinguishable. DETECTION: promise-returning exports
   whose results populate redux/state, reachable from a screen's mount effect.

   **(d) Module-scope caches the real bootstrap fills.** Own-root harnesses skip app startup, so
   module-singleton caches stay empty forever and throw far from the cause. Examples:
   `generateInitialLicenceInfos` (814) and the categories cache above. DETECTION: module-scope mutable
   state whose only writer is called from the bootstrap chain, not from any screen.

   **(e) React Contexts: real Provider vs default-only.** A diagnosis carried in this project's notes for
   ~20 sessions said three Contexts were "unwired"; two of them (`PaymentProvider`, `VouchersProvider`)
   have NO Provider component anywhere in the bundle and already ship complete `createContext` defaults —
   only `NativeLinkingProvider` (4329) was real. DETECTION: for each `createContext`, does a Provider
   component exist, and what is the default's shape? Cheap, and it kills a whole class of wrong guesses.

   **(f) Data-shape expectations for seeding.** Seeds silently mis-shaped cost several sessions: the licence
   card reads `codeDisplayClass`, not `name`; `dateOfBirth` is validated `DD/MM/YYYY` by `isValidDOBFormat`
   while every other date wants `YYYY-MM-DD`; `bodyContent` must be an ARRAY because the view `.map()`s it.
   Worst instance: `credentialInfoByLicenceType` (814) does a SHALLOW `Object.assign({}, licenceInfos,
   getVCInfos())[type]`, so a two-field seed WHOLESALE REPLACED the real licence object — latent for ~20
   sessions, surfacing later as three unrelated-looking screen crashes. DETECTION: for a given seeded object,
   report every field the real code actually reads off it, plus any shallow-merge shadowing hazard.

   WHY IT MATTERS BEYOND THIS APP: (a)-(c) are the difference between "the decompiled bundle runs" and "the
   decompiled bundle works on a platform it was not extracted from". The NSW hunt reached 60/60 screens on
   BOTH Android and iOS from one Android-built bundle — and every single failure along the way was one of
   these six classes or a harness bug. NONE was a decompiler mistranslation. A seam report turns that
   result from a 38-session archaeology project into a checklist.

7. **EMITTER: stop emitting `Reflect.apply` for ordinary calls — it is the systemic size AND speed cost.**
   Measured on the NSW bundle: **122,351 `Reflect.apply` call sites** in the decompiled output. The emitted
   shape is `r1 = Reflect.apply(r1, r2, [r3]);` where the ORIGINAL bytecode had a plain `Call` opcode.
   Every site pays: an argument-array allocation, two property lookups (`Reflect`, `.apply`), and a
   reflective dispatch — instead of one direct call instruction.

   IMPACT, measured end-to-end on a real app:
   - **Size:** original APK bundle 12,699,472 bytes; our decompile -> recompile 33,372,080 bytes — **2.63x**.
   - **Not fixable downstream:** terser with `--compress --mangle` shrank the JS 78.4MB -> 28.3MB (64%) but
     the resulting bytecode only fell 1.1% (33,372,080 -> 32,988,643). Minifiers cannot rewrite
     `Reflect.apply` into a direct call without knowing `thisArg` semantics. **The decompiler can** — it is
     reading the Call-vs-CallBuiltin distinction out of the bytecode and then throwing it away.
   - **Speed:** the owner's repeated complaint on a real device/simulator is that the rebuilt app is
     persistently slow, beyond what build type explains. 122k reflective dispatches plus 122k short-lived
     array allocations per full execution path is a plausible dominant cause, and it is GC pressure as well
     as raw dispatch cost.

   FIX: specialise at emit time. When `thisArg` is `undefined`/unused, emit `f(a, b)`. When the callee was
   loaded from the receiver, emit `obj.m(a, b)`. Keep `Reflect.apply` only for the genuinely dynamic cases
   (spread/computed arity) where it is actually needed. This is a pure code-generation change: the semantics
   are already known at emit time, and equivalence is checkable with the existing `runFunctionEquiv` oracle
   (spec 09 / `src/harness/hbc-equiv.ts`) function-by-function.

   WHY IT MATTERS: fidelity is already proven (the NSW hunt reached 60/60 screens on BOTH Android and iOS
   from one Android-built bundle, zero confirmed mistranslations). The remaining gap between decompiled
   output and the original is **efficiency**, and this single pattern is the bulk of it. Related smaller
   offender in the same vein: ~35.6k `break L<n>` label-block exits per 20MB sampled, i.e. structured
   control flow emitted as labelled breaks rather than natural loops/conditionals — worth measuring next.
