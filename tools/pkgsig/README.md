# tools/pkgsig/db — the D17/D17b shared signature-DB starter set

This directory used to also hold a standalone prototype pipeline
(`build-db.mjs`, `build-signatures.mjs`, `match.mjs`, `lib/*.mjs` — the T8
feasibility study, `docs/PACKAGE-SIGNATURES.md` §5). That code has been
**promoted into typed `src/deps/**`** and is now the real `hbc2js deps`
implementation (Lane B, `docs/DECISIONS.md` D17/D17a/D17b):

| Old prototype file | Promoted to |
|---|---|
| `lib/dscan.mjs` | `src/deps/dscan.ts` |
| `lib/sig-normalise.mjs` | `src/deps/sig-normalise.ts` |
| `lib/fingerprint.mjs` | `src/deps/fingerprint.ts` |
| `build-db.mjs` (bundle -> compile -> fingerprint) | `src/deps/confirm.ts` (the `--confirm` stage; fetches via `npm pack`, never `npm install`s the candidate) |
| `match.mjs` | `src/deps/match.ts` (scoring) + `src/deps/db.ts` (layered DB loading) |
| *(new)* | `src/deps/inventory.ts` (module inventory), `src/deps/guess.ts` (evidence-scored guessing), `src/deps/apk.ts` (APK-side evidence), `src/deps/report.ts` (the CLI report) |

Use the CLI instead of the old scripts:

```sh
hbc2js deps <bundle.hbc|app.apk> [--out <dir>] [--confirm] [--offline] \
  [--sigdb <dir>] [--no-shared-db] [--json]
```

See `docs/DEPS.md` for usage, the DB layering (project-local -> user cache ->
this directory), evidence weights, and how to contribute signatures upstream.

## What's still here

`db/` — the shared, starter signature-DB set this task built
(`docs/PACKAGE-SIGNATURES.md` §5.5): one JSON file per `package@version` x
HBC version (schema 2), plus `db/_baselines/` (the toolchain-empty/
react-foundation/react-native-foundation baselines every other file has
already had subtracted out of it) and `db/index.json` (a flat manifest).
This is the **shared** layer in `hbc2js deps`'s D17b lookup order
(`project-local -> user cache -> shared`, disabled with `--no-shared-db`) —
`src/deps/db.ts`'s `defaultSharedDbDir()` resolves straight to this
directory, both when running from `src/` and from a built `dist/` (this
directory ships alongside `dist/` in the published npm package —
see `package.json`'s `files`).

Nothing here is executable any more; it's data, read by `src/deps/db.ts`.

## Contributing a signature upstream

A project-local DB (`<out>/.hbc2js/sigdb/`, written by `hbc2js deps
--confirm`) uses the exact same file format as this directory. To promote a
confirmed signature into the shared set: copy the file from
`<out>/.hbc2js/sigdb/<pkg>@<version>__hbc<N>.json` into `db/` (or
`db/_baselines/` for a toolchain-baseline file), then run

```sh
node -e "require('./src/deps/db.ts')" # (illustrative — see writeSignature in src/deps/db.ts)
```

or simplest: re-run `hbc2js deps --confirm --sigdb tools/pkgsig/db <bundle>`
directly against this directory. **Only ever commit signatures fingerprinted
from public npm package code** — never anything derived from a proprietary
app's own bundle (D16 C5's rule extends here: the local corpus in
`~/hbc2js-local-corpus` must never leak into this directory, only the
*public* dependency versions it happens to use). Keep the shared DB under
~40 MB total (`docs/DEPS.md`); if a single package's signature file is
unusually large, note why rather than committing it anyway.
