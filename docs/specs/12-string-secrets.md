# Spec 12 — String + secrets indexer (P2.3)

Status: SPEC — review gate PASSED (2026-09-03, Fable reviewer; APPROVED with
in-place edits R1–R6 — see §11). Decision-8 quadruple verified in §7.
Implementation may launch at step 0 (§9).
Depends on: spec 10 (artifact format — string table + string-uses xref + query
caps), spec 11 (project store — finding/tag records, provenance, evidence
resolution). Consumed by: P2.7 orchestration loop; P2.4 (Semgrep findings sit
beside these in the same store); P2.5 (version diff of network surface).

## 0. What this is, in one paragraph

A cheap first-pass scanner that runs over a decompiled bundle's **string table**
(already extracted into the artifact by P2.1) and classifies every string:
secret-shaped material (vendor-prefixed API keys, JWTs, PEM blocks, high-entropy
blobs), the app's network surface (URLs, hosts, paths, schemes), and
interesting-category strings (SQL, deep-link schemes, feature flags,
debug/admin markers). Hits land in the **project store** as tool-provenance
findings and tags with evidence refs that resolve to string ids and use-sites.
It is the first tool an analyst (human or LLM) runs on a fresh bundle: seconds
of compute, a token-bounded report, and a worklist of candidates — **never**
an assertion that any candidate is a live secret.

Stage-2 criteria, in order (QUEUE STAGE 2 header):

1. **TRUTH** — every hit is a *candidate* with an explicit confidence tier and
   the pattern that fired; evidence refs must resolve (spec 11 §1.5); a capped
   or cached answer says so. A pattern match is a fact ("this string matches
   the AWS access-key-id format"); liveness is a claim this tool never makes.
2. **EFFICIENT TO USE** — one scan per artifact, cached by content; every query
   verb is capped like spec 10 §3.1; the LLM loop reads a ≤ 60-line report,
   not a string dump. Token cost of use is stated per verb (§5).

## 1. Inputs — built ON the artifact, never re-deriving it

The scanner consumes ONLY the P2.1 artifact (spec 10) via its published files
and `ArtifactService`. Explicitly:

- **`index/strings.json`** (spec 10 §2.3a) — `{sid, v}` rows; long strings are
  `{sid, len, sha256, head}`. The scanner scans `v` (or `head` for long rows —
  see §3.6 for the long-string rule).
- **`index/string-uses.jsonl`** (spec 10 §2.3b) — `{sid, fn, role, n}` rows.
  Used as-is for evidence refs and confidence input (a hit used as a
  `call-arg-literal` in 3 functions is more interesting than a data-only
  string with zero use rows). **This spec adds NO xref derivation** — spec 10
  already says "This file is what P2.3 (secrets indexer) scans"; if a needed
  fact is missing from the xref, that is a spec-10 extension request, not code
  here.
- **`manifest.json`** — `bundle` hash (cache key, §6) and provenance.
- **`ArtifactService.whoCalls`/`callsFrom`** — read-only, for the optional
  confidence-upgrade rule (§4.3). No raw-graph access; bounded rows only.

Non-input: hbc2js internals (`src/parse`, `src/disasm`, …). The scanner must
run against a bare artifact directory with no bundle present, except for
`query string <sid> --full` retrieval which spec 10 already owns.

## 2. Pattern set — source, format, versioning

### 2.1 Source and licensing

Patterns are **written by us from publicly documented token formats** (vendor
docs for key prefixes: AWS `AKIA`/`ASIA`, Google `AIza`, Stripe `sk_live_`/
`pk_live_`/`rk_live_`, GitHub `ghp_`/`gho_`, Slack `xox[bpars]-`, Twilio
`SK`+hex32, Firebase config shapes; RFC 7519 for JWT structure; RFC 7468 for
PEM encapsulation boundaries). Open-source scanner rulesets (gitleaks — MIT;
trufflehog — **AGPL-3.0**, the same license class as hermes-dec) may be
consulted as *behaviour references* for which formats exist and roughly how
strict to be, oracle-only: **copying a regex from either ruleset is a
violation of this spec** — mandatory for AGPL trufflehog, and our citation
discipline even for MIT gitleaks. Each pattern cites the vendor doc or RFC it
was derived from in its `source` field, and must be derivable from that
citation alone. (Reviewer edit R2: the spec previously called both rulesets
permissively licensed; trufflehog v3 is AGPL-3.0.)

### 2.2 Format

One versioned data module, `src/secrets/patterns.ts`, exporting:

```ts
export const PATTERN_SET_VERSION = "hbc2js-secrets/1";

export interface SecretPattern {
  id: string;            // stable, never reused: "aws-akid", "jwt", "pem-block"
  category: Category;    // §3.1 taxonomy
  tier: "A" | "B" | "C"; // §4.1 confidence tier this pattern yields on match
  re: RegExp;            // anchored where the format is anchored
  entropyGate?: { alphabet: "base64" | "hex" | "any";
                  minBitsPerChar: number; minLen: number };
  source: string;        // vendor doc / RFC the format was derived from
  note?: string;
}
export const PATTERNS: SecretPattern[];
export const THRESHOLDS: { base64: {minBitsPerChar: number; minLen: number};
                           hex:    {minBitsPerChar: number; minLen: number};
                           generic:{minBitsPerChar: number; minLen: number} };
```

- **Versioning**: `PATTERN_SET_VERSION` bumps its integer whenever a pattern
  is added, removed, or its regex/threshold changes. Pattern `id`s are
  append-only — a retired pattern's id is never reused (findings reference
  ids; a reused id would silently re-mean old evidence). Every scan result and
  cache entry records the version it was produced under (§6).
- **Extension**: adding a pattern = append to `PATTERNS` + bump version + add
  a row to the seeded ground-truth fixture (§7.3) exercising it + rerun the
  measure step (§7.4). Enforced by acceptance test T3 (§8): every pattern id
  must appear in the seeded fixture's expectations.

### 2.3 v1 pattern inventory (the concrete starting set)

| id | category | tier | shape (prose; the regex is the impl's, derived from the cited source) |
|---|---|---|---|
| `aws-akid` | secret/aws | A | `(AKIA\|ASIA)` + 16 uppercase base32 chars, word-bounded |
| `aws-secret-ctx` | secret/aws | B | 40-char base64-ish token whose *use-site or neighbour string* mentions `aws`/`secret` (context-gated; alone it is tier C generic) |
| `gcp-api-key` | secret/gcp | A | `AIza` + 35 `[0-9A-Za-z_-]` |
| `firebase-config` | secret/firebase | B | `AIza…` co-occurring with a `*.firebaseio.com` / `firebaseapp.com` URL in the same bundle (pairing rule, §3.4) |
| `stripe-key` | secret/stripe | A | `(sk\|pk\|rk)_(live\|test)_` + ≥ 24 alnum |
| `github-token` | secret/github | A | `gh[pousr]_` + 36 alnum |
| `slack-token` | secret/slack | A | `xox[bpars]-` + digit/alnum groups |
| `twilio-sid-key` | secret/twilio | B | `(AC\|SK)` + 32 hex |
| `jwt` | secret/jwt | A | three dot-separated base64url segments, first decoding to `{"alg":…` (structural check, not just shape) |
| `pem-block` | secret/pem | A | `-----BEGIN … PRIVATE KEY-----` (private-key/cert boundaries per RFC 7468; PUBLIC KEY blocks tag `endpoint`-grade interest, tier C, not secret) |
| `basic-auth-url` | secret/url-creds | A | scheme `://user:pass@host` — credentials embedded in a URL |
| `generic-entropy-b64` | secret/generic | C | base64-alphabet run, len ≥ 20, Shannon entropy ≥ `THRESHOLDS.base64` |
| `generic-entropy-hex` | secret/generic | C | hex run, len ≥ 32, entropy ≥ `THRESHOLDS.hex` |
| `url` | endpoint | — | RFC 3986-ish absolute URL; extracts scheme/host/path |
| `path-fragment` | endpoint | — | string starting `/` with ≥ 2 path segments and no whitespace (Metro-bundled apps concatenate base + path; this catches the halves) |
| `deep-link` | deeplink | — | non-http(s) scheme `myapp://…`, plus `intent://` |
| `sql` | sql | — | leading `SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/PRAGMA` + statement-ish tail |
| `feature-flag` | flag | — | key-shaped string matching `(enable\|disable\|flag\|experiment\|rollout)`-bearing identifier conventions, only when `role` ∈ property-key/property-get (xref-gated to cut FPs) |
| `debug-admin` | debug | — | `debug`/`staging`/`internal`/`admin`/`bypass`-bearing identifiers or URLs, same role gate as `feature-flag` |

Tier "—" categories (endpoint/deeplink/sql/flag/debug) produce **tags**, not
findings (§4.2) — they are surface mapping, not secret candidates.

### 2.4 Entropy scoring

Shannon entropy in bits/char over the candidate substring, computed per
alphabet class (a hex string maxes at 4 bits/char, base64 at 6 — one global
threshold would be wrong for both; hence per-alphabet thresholds in
`THRESHOLDS`). Initial values (base64 ≥ 4.0 bits/char & len ≥ 20; hex ≥ 3.0 &
len ≥ 32; generic ≥ 4.5 & len ≥ 24) are *starting points*, tuned per §7.4 on
the tuning corpus ONLY, and shipped as data in `patterns.ts` so a threshold
change is a versioned pattern-set change like any other. Guards that exist
regardless of entropy: skip strings that parse as pure natural language
(≥ 40% ASCII-space/letter bigrams), minified-identifier runs (`_0x…` sequences
are Stage-3 obfuscation material, not secrets), and data-URI image payloads
(`data:image/…;base64,` prefix → tag `asset`, never a secret candidate).

## 3. Scan semantics

### 3.1 Category taxonomy

`secret/<vendor>` (aws, gcp, firebase, stripe, github, slack, twilio, jwt,
pem, url-creds, generic), `endpoint`, `deeplink`, `sql`, `flag`, `debug`,
`asset`. Closed set per pattern-set version; extending it is a version bump.

### 3.2 The scan

One streaming pass over `strings.json` rows. For each string value: run the
compiled pattern set (single combined pre-filter regex of all anchors/prefixes
first, per-pattern regex only on pre-filter hit — this is the O(total-bytes)
guarantee behind §5's time bound), then entropy gates. Each hit yields
`{sid, patternId, category, tier, span:[start,len], extracted?}` where
`extracted` is structured payload for some categories (url → `{scheme, host,
path}`; jwt → decoded header `alg`, `payload` **key names only** — never
payload values, which may themselves be secrets we should not copy into a
report). Then join with `string-uses.jsonl` rows for that sid to build
evidence (§4.2).

### 3.3 Network surface

All `url`/`path-fragment` hits aggregate into the **network surface** view:
unique hosts with per-host path list and per-host use-function count. This is
a *derived view computed at query time* from the stored tags — not a third
storage format (one source of truth; the report renders it).

### 3.4 Pairing rules

Two v1 pairing rules, both bundle-local and cheap: `firebase-config` (§2.3)
and `aws-secret-ctx` (a generic 40-char token upgrades C→B only if an
`aws`/`secret`-bearing string shares a use-function with it, per
`string-uses.jsonl`). Pairing uses ONLY existing xref rows — no new analysis.

### 3.5 What a hit is NOT (truth posture)

A hit asserts exactly: "string `sid` matches pattern `p` at span `s`, and the
xref says it is used at these sites." It never asserts the credential is
valid, live, or the app's own (test keys, docs examples, and revoked keys all
match). The finding's `claim` text is written in candidate language
("candidate AWS access key id (pattern aws-akid, tier A)") and `status` is
always `open` on creation. Upgrades are §4.3's business, never the scanner's.

### 3.6 Long strings

For `{sid, len, sha256, head}` rows (> 4 KB, spec 10 §2.3a) the scanner scans
the 256-char head only and, on any hit OR when `len` and head suggest a blob
(base64 alphabet head), emits a tier-C finding with `note:
"head-only scan; retrieve via query string <sid> --full"` — the record states
its own incompleteness (spec 10's never-silently-truncate rule). v1 does NOT
fetch full values (keeps the scanner bundle-free, §1); a `--deep` flag doing
so via the bundle is a stated v1.1 extension.

## 4. Output — records in the project store

### 4.1 Confidence tiers and severity mapping

| tier | meaning | example | initial severity |
|---|---|---|---|
| A | structured format with vendor-anchored prefix or structural validation; near-zero FP by construction | `AKIA…`, decoded JWT, PEM private key | `high` |
| B | vendor-shaped or context-paired but not self-validating | Twilio hex, firebase pairing | `med` |
| C | generic high-entropy only | random base64 blob | `low` |

Spec 11 says "severity is analyst-assigned; the store does not compute it."
Reconciliation: the *indexer is the analyst of record* for its own findings —
it assigns the initial severity by this fixed, documented mapping, stamped
with `prov.source:"tool"`; the store computes nothing; any human/LLM
supersedes it like any record. The mapping is part of the pattern-set version.

### 4.2 Record shapes (exact)

**Secret candidates → `finding` records** (spec 11 §1.5 envelope, §2.1 common
fields; nothing new is invented — these are ordinary findings):

```json
{ "kind": "finding",
  "claim": "candidate AWS access key id (pattern aws-akid, tier A)",
  "severity": "high",
  "target": "sid:1203",
  "evidence": [
    { "ref": "sid:1203", "role": "match", "span": [0, 20], "patternId": "aws-akid" },
    { "ref": "fn:42", "role": "use-site", "useRole": "call-arg-literal", "n": 2 },
    { "ref": "fn:57", "role": "use-site", "useRole": "literal", "n": 1 }
  ],
  "status": "open",
  "cwe": "CWE-798",
  "prov": { "source": "tool", "who": "secrets-indexer",
            "run": "scan:<bundleHash8>:<patternSetVersion>:<n>" },
  "ctx": { "tier": "A", "patternSetVersion": "hbc2js-secrets/1" } }
```

- `target` is the `sid` (spec 11 permits `sid:N` targets); one finding per
  (sid, patternId) — multiple patterns on one string are multiple findings.
  `patternId` is the finding-slot discriminator in spec 11 §2.1's
  `(kind,target[,tag])` sense: the writer supersedes only within its own
  (finding, sid, patternId) slot, so two patterns' findings on one string
  coexist. (Reviewer edit R3: read literally, spec 11 §2.1 would otherwise
  have the second pattern's finding supersede the first.)
- **Every evidence ref resolves** (spec 11 §1.5): `sid:N` must exist in
  `strings.json`; each `fn:N` comes verbatim from a `string-uses.jsonl` row.
  A string with zero use rows still gets its finding (data-only strings are
  real) with the single `match` ref and `note:"no use sites in xref"`.
- `evidence[].span` locates the match inside the string so a reviewer checks
  it via `query string <sid>` without the tool quoting the secret at length;
  reports render at most the first 8 chars + `…` of matched secret material
  (don't multiply copies of a possibly-live credential into logs/context).

**Category hits (endpoint/deeplink/sql/flag/debug/asset) → `tag` records**
(spec 11 §1.3): `{ kind:"tag", target:"sid:N", tag:"<category>",
note:"<patternId>[ host=api.example.com]", prov:{source:"tool", …} }`.
This requires adding these category values to spec 11 §1.3's tag taxonomy —
a closed-set extension **ratified at this spec's review gate** (ruling 1,
§11; spec 11 defines its taxonomy as extensible by a reviewed commit, and
this gate is that review). The spec-11 §1.3 edit lands in the same commit as
impl step 3: add the six values and extend the tool-may-propose sentence to
cover them (provenance-stamped, refutable, like `provably-dead`). The
info-findings fallback is dropped. (Reviewer edit R5; also fixed a stale
§10 cross-reference — the open questions are §11.)

**Scan bookkeeping → NOT a new record kind.** Spec 11's `kind` enum is
closed; scan metadata (pattern-set version, timing, cache stats, per-category
counts at scan time) lives in `secrets/scan-state.json` beside the store
inside the artifact directory (§6). Findings/tags carry the pattern-set
version in `ctx`, so store records are self-describing without a scan kind.

### 4.3 Upgrade and refutation rules

- **open → confirmed** requires dynamic evidence per spec 11 §1.5 (a
  `trace:`/`fuzz:` ref, or an analyst-provided repro). This tool never writes
  `confirmed`.
- **Static corroboration ≠ confirmation.** If a use-site function reaches a
  network-call function in ≤ 2 hops of `callsFrom` (against the artifact's
  native-surface/call rows), the indexer *appends* a `{ref:"fn:N",
  role:"context", note:"reaches network sink fn:M in k hops"}` evidence ref
  and may raise C→B. Status stays `open`. This is the only call-graph use,
  it is bounded (≤ 2 hops from use-site fns only), and it is v1-optional
  (impl step 5, cuttable without failing acceptance).
- **Refutation** is a normal spec-11 status transition with counter-evidence
  (e.g. `note:"docs example key"`). Re-scans NEVER resurrect a refuted
  finding, and the suppression is driven by the **store, not the cache**: on
  emit the writer looks up the (finding, sid, patternId) slot and, if its
  active record is `refuted`, skips emission, leaving the refuted chain
  visible. The cache (§6, keyed by value-hash + patternSetVersion) is a
  performance layer only; a pattern-set bump invalidates the cache but MUST
  NOT resurrect a refuted slot — pattern ids are never reused (§2.2), so the
  slot key survives bumps. (Reviewer edit R1: as previously written the skip
  read as cache-driven, which the first pattern-set bump would have wiped.)
  Silent resurrection would be the store-corruption failure spec 11 exists
  to prevent.

## 5. Query verbs + token cost of use

Same contract as spec 10 §3.1: ids + one-line facts, caps announced when hit,
`--all` pages. Served warm by the same process as `ArtifactService` /
`ProjectService` (no per-call bundle parse — the P2.1a lesson).

| verb | answer shape | bound (default) |
|---|---|---|
| `secrets scan [--force]` | runs/refreshes the scan; one summary line per category: `secret/aws 2 new, 1 cached` + totals + wall time | ≤ 25 lines |
| `secrets report` | THE first-look answer: per-category counts, tier breakdown, top 10 findings (`#id tier sev sid head8… fnCount`), top 10 hosts by use count | ≤ 60 lines |
| `secrets list --category c [--tier t]` | one line per finding/tag: `#12 A high sid:1203 AKIA5…​ uses:3 aws-akid` | ≤ 50 lines + total |
| `secrets show <finding-id>` | delegates to `project finding show` + the matched span rendered with 8-char cap | ≤ 20 lines |
| `secrets hosts` | network surface: `api.example.com  paths:14  fns:37`, one line per host | ≤ 50 lines + total |
| `secrets paths <host>` | that host's paths + first use-fn each | ≤ 50 lines + total |

Token cost of use, stated (Stage-2 rule): the intended loop is `secrets scan`
(once, ≤ 25 lines) → `secrets report` (≤ 60) → a handful of `list`/`show`/
`paths` calls (≤ 50 each). A full first-pass triage of a 4k-function bundle
costs the LLM **under ~2,500 output tokens of tool text**, independent of
bundle size. No verb ever emits a whole string table or store dump.

Service API mirror (the loop imports this; rows identical to the CLI):

```ts
class SecretsService {
  constructor(artifact: ArtifactService, project: ProjectService)
  scan(opts?: {force?: boolean}): ScanSummary
  report(): ReportRow[]
  list(q: {category?: Category; tier?: Tier}, page?): FindingRow[]
  hosts(page?): HostRow[]
  paths(host: string, page?): PathRow[]
}
```

## 6. Efficiency, bounds, incremental re-scan

- **Time bound**: full cold scan of a 4k-function bundle (~30–60k strings,
  ~5 MB of string bytes — rn-template scale per spec 10 §measurements) in
  **< 5 s** on the dev machine, excluding artifact production; warm re-scan
  with unchanged inputs **< 0.5 s** (cache hit, no regex work). Measured in
  §7.4. Mechanism: single pass, combined pre-filter regex, per-pattern regex
  only on pre-filter hits, O(len) entropy.
- **Cache**: `secrets/scan-state.json` in the artifact dir maps
  `sha256(value) + PATTERN_SET_VERSION → verdict` (hit list or clean).
  Correctness argument: a verdict depends ONLY on (string value, pattern set)
  — use-site evidence is re-joined fresh from `string-uses.jsonl` on every
  emit, so xref changes are always reflected; only the regex/entropy work is
  cached. Spec 10 §1.3 has no incremental index, so on re-decompile of the
  same bundle sids are stable (they are the bundle's own string-table ids) and
  the cache makes re-scan a near-no-op; a pattern-set bump invalidates every
  entry by key construction. Cross-*version* bundles (different bytes, shifted
  sids) get a fresh scan per artifact — carrying findings across app versions
  is P2.5's job, explicitly not this spec's.
- **Idempotence**: re-emitting an existing (sid, patternId) finding with
  identical content is a no-op (no supersede churn in the store); changed
  content (new use rows, tier change) supersedes per spec 11 §2.1.

## 7. Decision-8 quadruple (metric / target / measurement / held-out)

### 7.1 Metrics

1. **Recall** on the seeded ground-truth fixture (§7.3): found seeded secrets
   ÷ seeded secrets, per tier.
2. **False-positive rate**: secret-findings on known-clean strings per 1,000
   strings scanned, on a corpus bundle with a reviewed allowlist of true
   positives (a real bundle may legitimately contain e.g. public API keys).
3. **Scan wall-time** cold and warm (§6 bounds).

### 7.2 Targets

- Recall: **100% tier A** (anchored formats — missing one is a pattern bug),
  **≥ 95% overall** across the seeded set.
- FP rate: **≤ 5 secret-findings per 1,000 strings** on the tuning corpus and
  **≤ 8 per 1,000 on the held-out corpus** (looser: held-out is never tuned
  on, by definition). Tag categories (endpoint/sql/…) are surface-mapping,
  excluded from the FP metric but spot-checked in review.
- Time: cold < 5 s, warm < 0.5 s at 4k-fn scale (§6).

### 7.3 Measurement method — the seeded ground-truth fixture

`tests/fixtures/secrets/seeded/` (new, spec-defined, checked in):

- `ground-truth.json`: ~50 entries `{ value, patternId, tier, category }` —
  synthetic secrets in every v1 pattern's format (fake AWS key `AKIAIOSFODNN7EXAMPLE`-style,
  self-signed throwaway PEM, HS256 JWT signed with `"test"`, etc. — **all
  synthetic/officially-published-example values, nothing live**), plus ~30
  deliberate near-misses `{ value, expect: "clean" }` (a 19-char base64 run,
  an English sentence, a minified-identifier run, a data-URI image) that MUST
  NOT hit.
- `strings.json` + `string-uses.jsonl`: a tiny hand-written artifact index
  in spec 10's exact row format (same technique as spec 10's A-test tiny
  artifact) embedding every ground-truth value among ~200 realistic filler
  strings lifted from rn-template's actual table. This tests the scanner at
  the artifact boundary without needing compilation, so it runs on every
  platform with no toolchain.
- Additionally one **end-to-end** check on a real fixture: run the scanner on
  the committed rn-template bundle's artifact and assert (a) zero tier-A
  secret findings above the allowlist (a stock RN template contains no real
  keys) and (b) the endpoint tag set includes the template's known hosts.
  This catches artifact-boundary drift the synthetic fixture can't.

Recall/FP are computed by `tools/secrets/measure.ts` (impl step 4) which runs
the scanner over the seeded artifact + tuning corpus and prints the quadruple
numbers; wired into the landing report, and the numeric targets asserted in
the acceptance tests (§8, T5).

### 7.4 Tuning vs held-out

- **Tuning corpus** (thresholds and pattern tweaks may iterate on these):
  the seeded fixture + the rn-template bundle (`tests/fixtures/bundles/`).
- **Held-out** (NEVER used while tuning; measured once at acceptance and then
  on pattern-set bumps): the **react-navigation bundle** (`bundles/fetch.sh`),
  FP rate ≤ 8/1k with a one-pass reviewed allowlist. If tuning ever needs the
  held-out app, it stops being held-out — promote it to tuning and nominate a
  replacement (Expensify bundle) in the same commit; the measure tool records
  which corpus played which role in `scan-state.json` so the roles are audit-
  able, not folklore. A red T8 during threshold iteration IS "tuning needs
  the held-out app": the promote-and-replace rule fires — never a quiet
  threshold tweak measured against react-navigation while it still counts as
  held-out. (Reviewer edit R4.)

## 8. Acceptance tests

Constraint: this spec's author writes only under `docs/specs/` (concurrent
agent owns `tests/**` today), so the pre-impl-runnable tests are specified
here as exact drop-in files; impl step 0 lands them verbatim as
`tests/secrets/*.test.ts` before any scanner code, and they must FAIL (not
error-out on import) until their step lands. No exact-output assertions on
shared construct fixtures (CONSOLIDATION §B) — T4's rn-template assertions are
counts/set-membership, never literal output.

- **T1 (pattern-set integrity — runnable the moment `patterns.ts` exists,
  step 0):** every pattern has a unique never-reused id, a `source` citation,
  a tier or tag category; `PATTERN_SET_VERSION` matches `hbc2js-secrets/\d+`;
  compiled regexes accept their §2.3 canonical example and reject the empty
  string.

  ```ts
  import { PATTERNS, PATTERN_SET_VERSION } from "../../src/secrets/patterns.ts";
  test("T1 ids unique + sourced", () => {
    const ids = PATTERNS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of PATTERNS) { assert.ok(p.source.length > 0); assert.ok(!p.re.test("")); }
    assert.match(PATTERN_SET_VERSION, /^hbc2js-secrets\/\d+$/);
  });
  ```

- **T2 (classifier recall/FP on ground truth, step 1):** for every
  `ground-truth.json` entry, `classify(value)` yields the expected
  `(patternId, tier)`; every `expect:"clean"` entry yields no secret hit.
  Asserts the §7.2 recall numbers exactly (100% A, ≥ 95% overall — on the
  seeded set these are computable deterministically).
- **T3 (pattern↔fixture closure, step 1):** every `PATTERNS[].id` appears in
  at least one ground-truth entry — a pattern nobody measures cannot ship
  (§2.2 extension rule, enforced).
- **T4 (artifact-boundary + store round-trip, step 3):** run the scanner over
  the seeded tiny artifact (§7.3); assert every emitted finding's evidence
  refs resolve against that artifact's `strings.json`/`string-uses.jsonl`
  (re-implementing spec 11 §4.1 resolution as an independent check, not
  calling the writer's own validator); assert `prov.source === "tool"`;
  assert one finding per (sid, patternId); assert a data-only seeded string
  still produced its finding with the no-use-sites note. Then re-run the scan
  and assert zero superseded records (idempotence, §6) and cache hits > 0.
- **T5 (measure gate, step 4):** `tools/secrets/measure.ts --json` on the
  seeded fixture + rn-template meets §7.2: recall targets, FP ≤ 5/1k tuning,
  cold wall-time under bound (time asserted with generous CI slack ×3, the
  hard < 5 s number is the landing report's to demonstrate on dev hardware).
- **T6 (caps + truncation truthfulness, step 4):** with > 60 seeded findings,
  `secrets report` emits ≤ 60 lines and a `… N more` marker; `secrets list`
  caps at 50 + total; no verb output contains more than 8 consecutive chars
  of any seeded secret value (the §4.2 quoting cap, checked mechanically by
  searching verb output for full seeded values).
- **T7 (refutation is sticky, step 3):** refute a seeded finding via the
  project store, re-scan, assert the finding is not resurrected and the
  refuted record chain is intact.
- **T8 (held-out, once, step 5/landing):** measure on react-navigation;
  assert FP ≤ 8/1k. Skips (with the standard oracle-skip marker) when
  `bundles/fetch.sh` output is absent; `HBC2JS_REQUIRE_ORACLES=1` makes the
  skip a failure.

**Implementation note (2026-09-03): fixture defused at rest.** GitHub push
protection flagged four values in the committed seeded fixture at ac65a50
(Stripe live key, Slack token, Stripe restricted test key, Twilio SID) and
blocked pushes — correctly: the fixture's whole point (§7.3) is that its
synthetic secrets are *format-faithful*, so a scanner cannot and should not
distinguish them from real ones by shape alone. Defense in depth means the
repo should never contain a format-live value regardless of provenance, so
`tests/fixtures/secrets/seeded/{ground-truth.json,strings.json}` now store
every seeded secret **defused at rest**: base64-encode the real value, split
the base64 into 8-char chunks joined by `.`, prefix with `hbc2js-defused:`.
The chunk size is deliberately under every pattern's length threshold (JWT
segments need ≥10 chars, the tier-C generic-entropy patterns need ≥20/≥32)
so the at-rest text matches none of `src/secrets/patterns.ts`'s anchored
formats — see `tests/fixtures/secrets/seeded/README.md` for the full
rationale and `tests/secrets/at-rest-defused.test.ts` for the standing
check. `tests/secrets/support/materialize.ts` reverses the encoding at test
time only, writing the TRUE spec-10 artifact (real-format values) into a
scratch dir under `os.tmpdir()`; every T-test that needs real values calls
`loadGroundTruth()` / `materializeArtifact()` instead of reading the fixture
directory directly. `nearMisses` values that don't match any anchored
pattern by construction (§7.3) stay literal, matching the spec's own
"near-misses ... MUST NOT hit" framing.

## 9. Implementation plan (lean-agent-sized, ordered)

Reuse explicitly: artifact string index + `ArtifactService` (spec 10 — read
only), project-store writer + evidence validation + supersede machinery
(spec 11 / `RevisionStore` — write through it, never raw JSONL appends), the
CLI plumbing and cap/paging helpers the spec-10 query verbs use. New code:
`src/secrets/` (patterns, entropy, classifier, scan driver, cache),
`tools/secrets/measure.ts`, `tests/secrets/`, `tests/fixtures/secrets/seeded/`.

1. **Step 0 — patterns + tests skeleton** (S): `src/secrets/patterns.ts`
   (§2.2/§2.3), land T1 + the T2–T8 files from §8 verbatim (failing), seeded
   `ground-truth.json`. No scanner yet.
2. **Step 1 — classifier core** (M): `classify(value): Hit[]` — pre-filter +
   per-pattern + entropy module (§2.4) + guards; tiny hand-written seeded
   artifact files; T2/T3 green. Pure functions, no I/O.
3. **Step 2 — scan driver** (S): stream `strings.json`, join
   `string-uses.jsonl`, pairing rules (§3.4), long-string rule (§3.6),
   produce in-memory findings/tags. No store writes yet.
4. **Step 3 — store integration + cache** (M): write through
   `ProjectService`/`RevisionStore` with §4.2 shapes; idempotent re-emit;
   refutation-sticky skip; `scan-state.json` cache. T4/T7 green. (Blocked on
   spec-11 impl step 1 landing `RevisionStore<T>`; coordinate via QUEUE — if
   it stalls, ruling 4 in §11 governs the interim.)
5. **Step 4 — CLI verbs + measure + tune** (M): §5 verbs on the warm service,
   caps, `measure.ts`, tune thresholds on tuning corpus only, T5/T6 green;
   record numbers in the landing report.
6. **Step 5 — optional in v1** (S): call-graph corroboration (§4.3), held-out
   run T8, docs (`docs/SECRETS.md` one-pager + STATUS/AGENT-LOG rows). If
   step 5's corroboration slips, T8 still runs — corroboration affects tiers,
   not the FP metric's numerator definition (secret findings of any tier).

## 10. Non-goals (v1)

- **No network calls, ever, in v1 — explicitly no key-validity probing.**
  Security rationale: probing a candidate key against the vendor (a)
  *transmits a possibly-live credential we do not own* to a third party from
  an analyst's machine, (b) is an unauthorized use of that credential (legally
  distinct from reading it out of a binary the analyst may analyse), and (c)
  tips off any monitoring on the key. Validity checking, if it ever exists,
  is a separate consent-gated tool, not a default scan step. Also banned for
  the boring reason: the gate must run offline and deterministically.
- **No secret *value* propagation into reports/logs** beyond the 8-char head
  (§4.2) — the tool must not become the leak.
- **No cross-app-version finding carry-over** (sids shift) — P2.5.
- **No deobfuscated-string scanning** (`_0x…` string-array decode is
  Stage 3); v1 scans the table as the bundle ships it. When Stage 3 lands
  decoded values into the artifact, this scanner re-runs unchanged over them.
- **No liveness/exploitability claims, no `confirmed` status writes** (§4.3).
- **No ML/embedding classification** — regex + entropy + xref roles only;
  measurable, versionable, explainable.
- **No source-code scanning of rendered JS** — strings are scanned in the
  table (one copy, sid-addressed); scanning rendered output would double-count
  and bind findings to render coordinates that churn. Semgrep-on-source is
  P2.4's lane.
- **No standalone report document format** — findings live in the store;
  the disclosure writeup format is P2.7's (spec 11 §1.6 already reserves it).

## 11. Review responses

*(Reviewer: verify the Decision-8 quadruple (§7) exists and the targets are
sane; rule on the §4.2 tag-taxonomy extension (open question 1); responses
land here.)*

Open questions for the reviewer:

1. **Tag taxonomy extension** (§4.2): add `endpoint|deeplink|sql|flag|debug|asset`
   to spec 11 §1.3's closed set, or take the fallback (info-tier findings)?
   Spec author recommends the extension — tags are the right weight for
   surface mapping, and spec 11 anticipated mechanical tag proposals.
2. **FP targets** (§7.2): 5/1k tuning, 8/1k held-out are set from scanner
   folklore, not measurement — sane starting bar, or tighten/loosen before
   impl? They become ratchets after the first measured landing either way.
3. **Severity reconciliation** (§4.1): does "indexer as analyst-of-record"
   satisfy spec 11's "severity is analyst-assigned", or must tool findings
   ship severity-less pending an analyst pass?
4. **Step 3 dependency**: P2.2 impl step 1 (`RevisionStore<T>` extraction) is
   in flight; if it stalls, is writing through the overlay-store pattern
   directly an acceptable interim, or does step 3 wait?

### Review responses (2026-09-03, Fable reviewer gate)

**VERDICT: APPROVED.** Implementation may launch at step 0 (§9). Every issue
found was fixed by a small in-place reviewer edit (R1–R6, marked in the text
where load-bearing) plus the four rulings below. No CHANGES REQUIRED items
remain.

**Checklist findings**

1. *Decision-8 quadruple (§7)*: complete. Metrics (recall / FP-per-1k /
   cold+warm wall time), targets (100% tier A + ≥ 95% overall recall on the
   seeded set; FP ≤ 5/1k tuning, ≤ 8/1k held-out; cold < 5 s, warm < 0.5 s at
   4k-fn scale), measurement (seeded ~50-secret + ~30-near-miss fixture in
   spec 10's exact row format, `tools/secrets/measure.ts`, T5 with ×3 CI
   slack and hard numbers demonstrated in the landing report), held-out
   (react-navigation, never tuned on, promote-and-replace with Expensify
   nominated, corpus roles recorded in `scan-state.json`). Targets are sane:
   100% tier-A recall is right for anchored formats (a miss is a pattern bug,
   not noise), and seeded-set recall is deterministic so T2 can assert it
   exactly. The FP metric correctly counts above a reviewed allowlist and
   excludes tag categories. Held-out discipline tightened by R4 (a red T8
   during tuning fires promote-and-replace, never a quiet threshold tweak).
   Note: react-navigation is also spec 11's held-out — different metrics, no
   tuning contact from either spec; acceptable, and the promote-and-replace
   rule keeps it honest.
2. *Record-contract conformance (§4 vs spec 11 as reviewed)*: the finding
   shape is the spec 11 §2.1 envelope with nothing invented; `sid:N` targets
   are envelope-legal; evidence roles `match`/`use-site`/`context` are
   additive (spec 11 names no closed role enum) and its §4.1 dynamic-role
   rule is untouched because this tool never writes `confirmed` — §4.3 is
   explicit, and static corroboration only appends context evidence and may
   raise C→B while status stays `open`; there is no self-confirm path.
   Evidence resolves at write (through `ProjectService`, spec 11 §4.1) and
   at read (spec 11 §3.3), independently re-checked by T4. Provenance is
   `tool` + run id on every record. One real gap fixed (R3): spec 11 §2.1's
   `(kind,target[,tag])` slot key, read literally, would have a second
   pattern's finding supersede the first on the same sid — `patternId` is
   now pinned as the finding-slot discriminator. Envelope fields
   (`rid`/`ts`/`supersedes`/`active`) are writer-assigned and correctly
   absent from the §4.2 example.
3. *Truth posture*: candidate language is pinned in claim text (§3.5) and no
   verb renders a liveness word. Refuted-never-resurrected was cache-driven
   as written — the first pattern-set bump invalidates the whole cache and
   would have resurrected every refuted finding; fixed (R1): suppression is
   store-driven off the active `refuted` record on the (finding, sid,
   patternId) slot, the cache is performance-only, and never-reused pattern
   ids make the slot survive bumps. The ≤ 8-char quoting cap holds
   everywhere checked: report/list/show verbs (§5; T6 checks mechanically
   that no verb output contains > 8 consecutive chars of a seeded value),
   evidence carries a span, never the value (§4.2), JWT extraction takes
   payload key names only (§3.2), url extraction drops userinfo, the cache
   stores sha256 not values (§6), and §10 bans value propagation into
   logs. Long strings are head-only scanned with the record stating its own
   incompleteness (§3.6).
4. *Licensing/provenance*: caught and fixed (R2) — the spec called gitleaks
   and trufflehog "both permissively licensed", but trufflehog v3 is
   AGPL-3.0. The wording now makes copying a regex from either ruleset a
   stated spec violation (mandatory for AGPL trufflehog, citation
   discipline even for MIT gitleaks), every pattern must be derivable from
   its cited vendor doc/RFC alone, and T1 enforces a citation per pattern.
   Ground-truth values are synthetic/officially-published examples only
   (§7.3); nothing live is committed.
5. *Inputs/efficiency*: artifact-only inputs with an explicit spec-10
   extension-request escape hatch (§1) — no re-derivation. O(total-bytes)
   scan via combined pre-filter; per-alphabet entropy thresholds are
   technically correct (hex maxes at 4 bits/char, base64 at 6). All verbs
   capped in the spec 10 §3.1 style with the truncation-says-so rule and a
   stated ~2,500-token first-pass budget.
6. *Implementation plan (§9)*: steps lean-agent-sized and ordered; steps
   0–2 are pure and unblocked; step 3's dependency on spec-11 impl step 1
   (`RevisionStore<T>`) is stated and ruling 4 governs a stall (R6
   cross-ref); step 5 is genuinely cuttable (corroboration affects tiers,
   not the FP numerator). Step 0 lands the §8 tests verbatim before any
   scanner code, satisfying tests-before-implementation despite the
   author's docs-only write scope.

**Rulings on the §11 open questions**

1. **Tag taxonomy: EXTEND spec 11 §1.3 with
   `endpoint|deeplink|sql|flag|debug|asset`.** Spec 11 defines its taxonomy
   as closed but extensible by "a reviewed commit"; this gate is that
   review. Tags are the right weight for surface mapping — info-tier
   findings would flood the findings lane and muddy the FP metric's
   secret-findings definition. Conditions (recorded in §4.2 by R5): the
   spec-11 §1.3 edit lands in the same commit as impl step 3, adds the six
   values, and extends the tool-may-propose sentence to cover them
   (provenance-stamped, refutable, like `provably-dead`). The
   info-findings fallback is dropped.
2. **FP bars: ACCEPT 5/1k tuning / 8/1k held-out as starting ratchets.**
   They are admitted folklore, but they are bounds not goals, the reviewed
   allowlist keeps them meaningful on real bundles, and Decision-8 demands
   a falsifiable pre-registered bar, not a proven-optimal one. After the
   first measured landing the measured value becomes the ratchet;
   loosening ever again requires a review, tightening does not.
3. **Severity: indexer-as-analyst-of-record SATISFIES spec 11 §1.5.** That
   rule's point is that the STORE computes nothing — and it still computes
   nothing: the writer (a tool-analyst stamped `prov.source:"tool"`)
   assigns severity by a fixed, documented mapping versioned with the
   pattern set, and any human/LLM supersedes it like any record; spec 11
   §4.2 already contemplates tool-authored, independently refutable
   records. Severity-less tool findings would be strictly worse — triage
   ordering would then be computed at display time, an unversioned,
   unauditable severity.
4. **Step-3 stall: WAIT by default; one narrow shim is the only permitted
   interim.** Raw JSONL appends stay forbidden regardless (§9). If
   `RevisionStore<T>` has not landed when steps 0–2 complete, the
   implementer may write through a thin shim over the existing
   name-overlay revision engine (`src/name-overlay/store.ts` already
   carries `rid`/`supersedes`/`active` — it IS the RevisionStore-to-be)
   provided the shim (a) keeps append-only supersede-within-slot
   semantics, (b) enforces evidence-must-resolve at write via
   `ArtifactService`, and (c) writes the final §4.2 shapes into the final
   `project/*.jsonl` locations so the P2.2 landing replaces the shim with
   zero record migration. If any of (a)–(c) cannot be met, step 3 waits
   and the QUEUE escalates.

**Edits applied (in place)**

- **R1** (§4.3): refutation suppression store-driven, not cache-driven;
  survives pattern-set bumps.
- **R2** (§2.1): trufflehog is AGPL-3.0, not permissive; copying a regex
  from either ruleset is a stated violation.
- **R3** (§4.2): `patternId` pinned as the finding-slot discriminator
  under spec 11 §2.1.
- **R4** (§7.4): a red T8 during tuning triggers promote-and-replace.
- **R5** (§4.2): taxonomy extension recorded as ratified with its landing
  condition; info-findings fallback dropped; §10→§11 cross-ref fixed.
- **R6** (status line, §9 step 3): gate-passed status; ruling-4 cross-ref.
