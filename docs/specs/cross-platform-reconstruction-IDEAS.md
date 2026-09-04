# Cross-platform app reconstruction — feasibility (IDEAS, 2026-09-04)

> Status: IDEAS. Captures the Fred/assistant design thread (native-side ingestion,
> Android-as-donor, and whether deps recall is good enough). Preserved here as a
> durable file because the QUEUE.md running-notes were lost to a concurrent
> orchestrator rewrite (itself live evidence for spec 18's hash-lock/adopt model).

## Goal
From an Android APK (trivially downloadable, unencrypted), reconstruct the shared
RN project and build it for EITHER platform. An RN app is ONE shared codebase ->
two builds; that shared source is almost entirely recoverable from the APK.

## Layers & who recovers them
- JS: hbc2js (Hermes bundle -> src/). Platform-agnostic; transfers as-is.
- Config: native react-native-config .env (from BuildConfig.smali / strings.xml on
  Android; Info.plist on iOS). Single .env feeds both builds. Proven on NSW:
  APIGEE_DOMAIN="https://api.g.service.nsw.gov.au" lived in strings.xml, NOT the .hbc.
- Dependencies: `deps` (package.json) + native-module inventory.
- Assets/manifest: direct extraction.

## The native-module split (the crux for cross-platform)
1. KNOWN third-party module -> identify -> declare the dependency -> the library
   ships BOTH platforms' native code itself (react-native-keychain's iOS side comes
   free on `pod install`). No reversing, no translation.
2. CUSTOM first-party module -> the only case needing behavior-recover (from
   smali/DEX, readable) then resynthesize to the target platform's APIs. Minority.

## Is deps recall good enough? (Fred's question)
Concrete NSW evidence: deps CONFIRMED 11 libs (high, db-match) + HINTED 16, but
MISSED crypto-js / jsrsasign / Auth0 SDK / redux stack. So JS-fingerprint recall is
currently PARTIAL. BUT recall is NOT the true bottleneck, for four reasons:

1. **The dominant libs are the easy ones.** react-native, react, navigation,
   reanimated, gesture-handler — the big structural native deps — are exactly what
   deps identifies with high confidence (popular -> in the sigdb). The misses are
   the smaller tail.
2. **Pure-JS libs don't need naming at all.** Their JS is IN the bundle and
   decompiles. Unidentified pure-JS lib = just inline the recovered JS (works, only
   less clean). So for pure-JS, recall is a cleanliness bonus, not a feasibility gate.
3. **Native libs have a SECOND, near-100% identification channel: the native side.**
   Native modules register with LITERAL package names in smali/manifest (e.g.
   `com.oblador.keychain.KeychainPackage`, `com.reactnativecommunity.webview.*`).
   Reading those names is far more reliable than JS fingerprinting — no guessing.
   Since we must ingest the native side anyway (config), native-lib recall can be
   HIGH by reading literal package names.
4. **The guess-confirm tool closes remaining JS gaps.** crypto-js/jsrsasign were
   missed only because they're not in the sigdb; they leave strong textual tells
   (AESAlgo, getKeyAndUnusedIvByPasscodeAndIvsalt). Evidence-directed fetch->build->
   fingerprint (deps-confirm-tool-IDEAS.md) adds them and improves per-bundle.

## Verdict
FEASIBLE. deps JS-recall being partial does NOT block reconstruction:
- pure-JS libs: inline if unnamed;
- native libs: identify with high reliability from literal native package names;
- fingerprint gaps: closed by guess-confirm.
Residual hard part = CUSTOM native modules (unavoidable, minority, identifiable as
custom because they sit in the app's own namespace e.g. au.gov.nsw.service.*), and
genuinely platform-DIVERGENT behavior (the only true entropy gap, ~0 for a normal
shared-codebase RN app). Direction asymmetry: Android is the canonical donor
(unencrypted; custom native is DEX/smali not iOS Mach-O machine code).

## Build steps to add (new capability, needs a spec)
1. Ingest APK native side: strings.xml/BuildConfig -> .env; AndroidManifest;
   assets; native-module registrations (literal package names) -> native dep list.
2. Merge native dep list with deps' JS-fingerprint list (two channels, dedup).
3. Emit a complete RN project: package.json + src/ + .env + assets, buildable for
   android and ios; flag custom native modules as TODO-resynthesize.
