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
- `endpoint-tables` / object-literal-group discovery by key-pattern (PATH_*) — the hunt
  found a SECOND complete endpoint table `LicenceAPIEndpoints` only by lucky grep. Need
  a one-shot inventory of all endpoint-constant tables.
- HTTP-method-per-path + header-origin trace (is `X-AGENCY-CODE` client- or session-
  derived?) — currently pure manual reading.
- JSX-prop / named-component-config locator (`originWhitelist={…}` on WebView, RN
  `linking` config) — blocked confirming WebView origin restrictions + deep-link map.
- AST pattern match "template literal containing a quoted string containing ${…}" — the
  WebView-injection anti-pattern (C1); would surface the bug class bundle-wide.
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
