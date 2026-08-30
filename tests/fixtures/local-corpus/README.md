# tests/fixtures/local-corpus/

Tier 2 / **C5** per `docs/DECISIONS.md` D16: proprietary APK-derived JS/Hermes
bundles, for local round-trip/parse testing only. **No source is available
for anything in this category** (unlike `tests/fixtures/bundles/` — the C3
open-source RN app corpus, which is MIT/BSD/Apache and fully committed or
`fetch.sh`-reproducible).

## Rules (D16 C5)

- **Never commit the extracted bundles or anything derived from them.**
  `tests/fixtures/local-corpus/*/` (everything except this README and
  `MANIFEST.json`) is gitignored.
- Only run `tools/extract-apk-bundle.sh` against APKs you have legitimately
  obtained (e.g. your own installed apps, your own debug builds, or apps you
  otherwise have the right to inspect). The script only extracts a bundle
  already present in a local file you point it at — it does not fetch,
  download, or search for anything itself.
- All analysis of C5 bundles is local. Oracles available for this category
  (per D16's table): parse, `node --check` (for plain-JS bundles),
  round-trip recompilation (D3) if a matching `hermesc` version can be
  sourced. No execution-trace oracle (D2) applies — there's no source to
  compare against. A sweep run with no local-corpus entries present reports
  those checks as **INCONCLUSIVE** (D15), never as a pass or a failure.
- `MANIFEST.json` **is** committed — it records only `sha256`, `size`,
  `hbcVersion`, `sourceApkName` (the APK's own filename, not the app's
  identity beyond that), `entryPath`, and `date` per entry. No source code,
  strings, or other bundle content is ever written into it.

## Layout

```
tests/fixtures/local-corpus/
  README.md          # this file (tracked)
  MANIFEST.json       # hash/metadata ledger (tracked)
  <sha256-prefix>/
    bundle.hbc        # or bundle.js, depending on what was found — gitignored
```

## Usage

```sh
tools/extract-apk-bundle.sh /path/to/some.apk
```

Looks for `assets/index.android.bundle`, then `assets/index.bundle`, then
any `assets/*.hbc`; detects Hermes bytecode vs. plain JS by the magic number
at the start of the file (`c6 1f bc 03 c1 03 19 1f`, per
`docs/TOOLCHAIN.md`), reads the HBC version if present, and records the
result under a directory named by the first 16 hex characters of the
bundle's own sha256.
