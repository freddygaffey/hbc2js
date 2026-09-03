# Seeded secrets ground-truth fixture — defused at rest

`ground-truth.json` and `index/strings.json` seed the spec 12 §7.3 recall/FP
measurement with synthetic secrets in every v1 pattern's format (fake AWS
key, throwaway self-signed PEM, `sk_live_`-prefixed Stripe key, …). All
values are synthetic/officially-published-example values — nothing live —
but being *format-faithful* is the entire point of the fixture, and that is
exactly what makes commit-scanning push-protection (rightly) flag them:
GitHub's scanner cannot tell "synthetic but correctly shaped" from "real".

So the fixture is stored **defused at rest**: no string in either checked-in
file matches any real secret's live format. Every seeded secret value is
stored as:

```
hbc2js-defused:<base64 of the real value>
```

Splitting the marker prefix from the base64 body this way means neither
piece triggers any vendor format (`sk_live_`, `xoxb-`, `AKIA`, `AC` + hex,
…) on its own, and a scanner reading the base64 body in isolation sees
generic base64 noise, not a shaped secret. This is the single scheme used
everywhere in the fixture — see `tests/secrets/support/materialize.ts` for
the encode/decode helpers (`defuse` / `undefuse`).

`nearMisses` entries (the ~30 `{ value, expect: "clean" }` rows — a 19-char
base64 run, an English sentence, a minified-identifier run, a data-URI
image) are **not** defused: by construction they do not match any real
secret format (that is what makes them useful as near-misses), so they stay
literal.

## Materializing the true artifact

Nothing under `src/` or `tools/` should ever read this directory directly.
Tests import `materializeArtifact()` / `loadGroundTruth()` from
`tests/secrets/support/materialize.ts`, which:

1. Reads this defused-at-rest fixture.
2. Reverses the `hbc2js-defused:` encoding on every seeded value.
3. Writes the TRUE spec-10 artifact (`index/strings.json`,
   `index/string-uses.jsonl` — spec 10 §2.3's actual nested layout — and a
   real-value `ground-truth.json`) into a fresh scratch directory under
   `os.tmpdir()`.

Only that materialized scratch copy — never this directory — is what the
scanner-under-test (`src/secrets/classify.ts`, `src/secrets/service.ts`,
`tools/secrets/measure.ts`) should be pointed at.

`tests/secrets/at-rest-defused.test.ts` is a standing check that greps this
directory for every pattern in `src/secrets/patterns.ts` (not just the four
GitHub push-protection caught) and fails if any of them ever matches again —
so a future fixture edit that pastes a literal value back in is caught
before it can be committed.
