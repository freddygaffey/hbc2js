# Deps guess-confirm tool — proposal (IDEAS, 2026-09-03)

> Status: IDEAS, not a spec. Needs a full researched spec by a stronger agent
> before build. Prompted by the NSW library list (scratchpad/nsw-library-list.md):
> the sigdb is strong on RN/navigation but BLIND to crypto libs (crypto-js,
> jsrsasign) and the Auth0 SDK — exactly where security-relevant code lives.

## 1. The idea
Turn a **guessed/hinted** library into a **confirmed** one automatically, on
demand, from a real bundle's own hints. Instead of pre-fingerprinting the npm
top-N (bulk round2b), this is DEMAND-DRIVEN and EVIDENCE-DIRECTED (per the deps
strategy: bounded, not exhaustive — only build what a bundle points at).

Pipeline, `guess → confirmed@version`:
1. **Input**: a package name (+ optional version/range) and the target bundle
   (or its unattributed modules).
2. **Fetch**: pull the package tarball from the npm registry (the cloud).
3. **Version resolve**: if version unknown, take a CANDIDATE SET — the app's
   build-date window and the RN-compatible range (deps.json gives RN version) —
   and fingerprint each candidate, keep the best match.
4. **Build to Hermes bytecode**: reproduce how the lib appears in the bundle —
   Metro-transform the package (Babel + module wrapping + minification) then
   `hermesc` at the target HBC version (v96 for NSW). This is the hard/fidelity
   step; reuse the existing sigdb build path, do not re-invent it.
5. **Fingerprint**: run the SAME function-level fingerprint the sigdb uses
   (structural, resilient to string-table/minification differences).
6. **Match + decide**: compare against the bundle's unattributed functions;
   above a coverage threshold → CONFIRM (pin the best-matching version), else
   REJECT the guess. Optionally PERSIST the new signatures into the sigdb.

## 2. Why it's the right shape
- **Evidence-directed** = aligns with Fred's bounded-not-exhaustive deps rule;
  builds signatures only for real hints, not petabytes of npm.
- **Closes the recall gap where it matters**: run it on the NSW hints and it
  confirms crypto-js, jsrsasign, react-native-auth0 — the security-relevant gaps.
- **Self-improving**: every confirm feeds the sigdb, so the next bundle needs it
  less. Turns the 16 hintedDeps + the code-found gaps into confirmed signatures.

## 3. Design constraints
- **Reuse**, don't rebuild: the sigdb already has a build + fingerprint path;
  this tool is the fetch + version-resolve + match + persist wrapper around it.
- **Local build** (deb is gone): Metro + hermesc run on this machine.
- **Cache** built signatures keyed by `pkg@version@hbcVersion`; a re-confirm is
  instant.
- **Bounded**: a few candidate versions per guess, capped; stop at first strong
  match.

## 4. Open questions for the full spec
- Build fidelity: how close must the local Metro/Babel/minify config be to the
  app's for fingerprints to match? Is the existing fingerprint resilient enough
  that config drift doesn't matter? (Measure on a known lib: build crypto-js,
  match against NSW's crypto-js modules, check coverage.)
- Version-window heuristic: how to pick candidate versions cheaply.
- Match threshold + how to report partial/ambiguous matches.
- sigdb write path: schema, dedup, provenance (which bundle confirmed it).
- Entry-point vs whole-package: fingerprint the package's own modules only,
  excluding its transitive deps (which are separate sigdb entries).

## 5. First targets (validate the tool on these)
crypto-js, jsrsasign, react-native-auth0 — the NSW gaps. If the tool confirms
all three against the NSW bundle, it works.
