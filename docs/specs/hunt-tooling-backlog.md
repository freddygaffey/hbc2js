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
2. **`query string-uses <id>` verb.** string-grep returns id+count, not the use SITES;
   data already exists in index/string-uses.jsonl (14MB). Easy, high-value.
3. **Scoped single-function readable decompile.** Today one function's readable JS
   costs a whole-module/bundle run (90s timeout). Needed for cheap per-lead context
   (also the LLM-loop token win, P2.1a).
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
**DOMINANT (hit in every direction — promote to #1):** `who-calls`/grep can't resolve
callers of `require(list[N]).method(...)` dynamic dispatch — this app's DOMINANT
calling convention, not an edge case. Blocked confirming B1 licence-link body, D3
PIN→jsrsasign wiring, A4 Auth0 reachability. FIX = a points-to / dataflow pass that
resolves `require(N)` even when N is register/list-indexed. Highest-value tool work.

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
