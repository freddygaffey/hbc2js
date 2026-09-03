# Seeded-vulnerable fixture — spec 13 (P2.4 reuse-validation) step 1

This is a synthetic, obviously-insecure test fixture for validating
third-party scanners (Semgrep, OSV, androguard) over hbc2js's decompiled
output. It is not a real app and ships no real secret, exploit, or working
vulnerability against any live system.

- `source/App.js` — RN-shaped source with 10 seeded vulnerability classes,
  one `// SEED:<class-id>` comment per class (spec 13 §2.3 step 1).
- `ground-truth.json` — machine-readable list of the 10 seed classes plus the
  ≥3 dependency pins with known OSV advisories (spec 13 §8.2).
- `lockfile.json` — the pinned `name@version` triples in lockfile shape,
  mirrored from `ground-truth.json.lockfilePins`.
- `vNN.hbc` — compiled from `source/App.js` with `hermesc` (one version, v96,
  suffices for the Semgrep lane per spec 13 §2.3 step 1: "Semgrep sees only
  the emitted JS"). Committed, like every other fixture `.hbc` — `build.sh`
  regenerates it where `tools/hermesc/v96/hermesc` is present
  (`tools/get-hermesc.sh 96`).

## Defused-at-rest credential

The `hardcoded-credential` seed (`API_SECRET` in `source/App.js`) is stored
**defused**: it is the `tests/secrets/support/materialize.ts` base64-chunked
encoding (`hbc2js-defused:` marker, 8-char chunks joined by `.`) of a fake
Stripe-shaped test string (the concatenation `"sk_live_" + "FAKE1234567890abcdefFAKE9876543210"` — written split here so this README itself never contains the contiguous format),
never the literal shape. This keeps the committed source and the committed
`.hbc` (which embeds the same string) free of any byte sequence that could
trip GitHub push protection or our own tier-C secret patterns
(`src/secrets/patterns.ts` generic-entropy/JWT prefilters) — see
`tests/secrets/at-rest-defused.test.ts` for the standing check on that
scheme, applied here to a second fixture reusing the same module.

Reproduce the defused value:

```js
import { defuse } from "../../../secrets/support/materialize.ts";
defuse("sk_live_" + "FAKE1234567890abcdefFAKE9876543210");
```

**Lane S (Semgrep, spec 13 step 3)**: if recall against a "hardcoded
credential shape" rule needs the *materialized* (real-shaped) value, undefuse
it (`undefuse()` from the same module) into a fresh scratch copy of
`source/App.js` at run time, compile *that* copy to a throwaway `.hbc` under
`os.tmpdir()`, and never write the materialized form back into this
directory or the repo — same discipline as
`tests/secrets/support/materialize.ts`'s own doc comment.

## What is NOT yet in this fixture (future steps)

- The `lockfilePins` packages (lodash/minimist/axios) are **not** compiled
  into `v96.hbc` — Lane O (step 2) extends this fixture's build to actually
  bundle them so `hbc2js deps --json` has something to match (spec 13 §8.2
  "extends the §2.3 fixture's build").
- No APK exists yet for Lane M (step 4); the manifest lane needs its own
  small Android project + `aapt2`/Android build tooling to produce one. Per
  spec 13 ruling R-A the built APK will be **committed** (like this `.hbc`),
  never required at gate time.
