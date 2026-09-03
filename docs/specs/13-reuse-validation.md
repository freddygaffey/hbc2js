# Spec 13 — P2.4 REUSE validation: existing scanners over hbc2js outputs

Status: SPEC — review gate PASSED (2026-09-03, Fable reviewer, §13). Design only — no implementation in
this commit. Style precedent: specs 10/11/12 (spec authoritative; reviewer gate
before impl; Decision-8 quadruple per lane). Stage-2 order of values applies:
TRUTH first, then EFFICIENT TO USE (QUEUE Stage-2 header).

## 0. What this is, in one paragraph

hbc2js now emits a decompiled per-module JS tree, an evidence-scored dependency
report (`src/deps`, `DepsReport`), and a project store for findings (spec 11).
Three classes of security signal are already covered by mature third-party
tools that *speak these formats as-is*: pattern/taint scanning over JS
(Semgrep), CVE matching over package@version pairs (OSV/GHSA), and Android
manifest analysis over the APK (androguard/apktool). This spec wires each of
them over our outputs — **reuse, not build** — with a hands-on validation
protocol per lane and a numeric adoption bar each lane must clear *before* its
output is trusted into the store. Every adopted lane lands its results as
spec-11 finding/tag records with `prov.source:"tool"`, resolving evidence, and
candidate-language discipline. A lane that fails its bar is documented and cut,
not shipped noisy. Everything runs LOCALLY on the M5; corpus bundles and code
never leave the machine (§6.4).

## 1. Inputs — built ON existing outputs, never re-deriving them

1. **Emitted JS tree** (Semgrep lane): the decompile-project output directory
   (`--out <dir>` per docs/DEPS.md; per-module files from the spec-10/11
   pipeline). Semgrep reads the tree as plain JS files; no adapter, no
   re-parse of bytecode.
2. **`DepsReport`** (OSV lane): `hbc2js deps --json` output
   (`src/deps/report.ts`) — `matchedDeps` (High/Medium/Low tiers per
   docs/PACKAGE-SIGNATURES.md §5.4), `guessedDeps` (aggregated evidence
   confidence ≥ 0.5, ≥ 2 evidence kinds), `hints`, plus confirm-stage version
   resolution (`usedPrereleaseVersion`, nearest-by-date flags). The OSV lane
   consumes this JSON only; it never re-runs matching logic.
3. **The APK itself** (manifest lane): the same `.apk` input `hbc2js deps`
   already accepts. hbc2js does not parse AndroidManifest.xml and will not
   start to — androguard/apktool own that.
4. **Project store** (all lanes, output side): records written through
   `ProjectService` (spec 11 §3.2), evidence resolved at write via
   `ArtifactService` (spec 11 §4.1). No lane writes JSONL directly (spec 12
   ruling 4 shim conditions apply identically if P2.2 step 5 has not landed).

Extension requests to spec 10/11 surfaces go through their escape hatches; this
spec invents no new store record kinds.

## 2. Lane S — Semgrep over the emitted JS tree

### 2.1 What runs

Semgrep OSS engine (CLI), invoked as a subprocess with `--metrics=off`
(mandatory — default telemetry would transmit scan metadata off-machine,
violating §6.4) and `--json`. Rulesets, two sources:

- **Registry rulesets** (`p/javascript` security subset, `p/security-audit`,
  taint rules for `eval`/`Function`/`child_process`/SQL/HTML/path/deep-link
  handling). Fetched at run time, cached under `~/.semgrep`, **pinned by
  ruleset SHA in `scan-state`** so a run is reproducible. NEVER vendored into
  this repo (licence, §5.1).
- **Our own rules** (`tools/security/semgrep/*.yaml`, authored from scratch,
  MIT like the repo): decompiled-JS-aware rules where registry rules go blind
  (e.g. Hermes-lowered string building, `__d()` factory boundaries, our
  runtime helpers). Writing rules is not "building a scanner": the engine,
  matcher and taint machinery are Semgrep's; a rule file is configuration.

### 2.2 Decompiled-JS quirks — what default rules mean here

Stated up front so hit classification (§2.3) is principled, not ad hoc:

- **Style/correctness rules are noise by construction.** Decompiled output has
  synthesized locals, flattened temporaries, duplicated guards and dead
  stores. Any rule whose point is "a human should not write this" (unused
  var, complexity, `var` vs `let` style) is meaningless here. These rule
  classes are excluded *a priori*; they never count in the metrics.
- **Security pattern rules mostly survive**: `eval(...)`, `child_process`
  usage, `crypto.createHash('md5')`, hardcoded-credential shapes, insecure
  `random` — these key on callee names and literals, which the decompiler
  preserves.
- **Taint rules partially survive**: Hermes lowering splits expressions
  through registers/temps; Semgrep's intraprocedural taint usually tracks
  through simple local assignment chains, but source→sink pairs that Metro
  split across module boundaries will not connect. Expectation set
  accordingly: the taint sub-lane is validated separately and is cuttable
  (§9) without dragging down the pattern sub-lane.
- **Module wrappers**: emitted `__d()` factories are plain functions; rules
  that require top-level `require('x')` may need our own rule variants.

### 2.3 Validation protocol (hands-on, before adoption)

1. Build the **seeded-vulnerable fixture**: a small RN-shaped source app
   (`tests/fixtures/security/vuln-app/source/`) containing ≥ 10 distinct
   seeded vulnerability classes (eval-of-network-data, command injection via
   child-process-style bridge call, SQL string build, insecure deep-link
   handler, weak hash, hardcoded credential, insecure random for token, HTML
   injection sink, path traversal build, disabled TLS check), each tagged in
   source with a `// SEED:<class-id>` comment and listed in a ground-truth
   JSON. Compile with hermesc (per-version like other fixtures; one version,
   v96, suffices for this lane — Semgrep sees only the emitted JS), decompile
   with the real pipeline.
2. Run candidate rulesets over (a) the fixture tree, (b) the decompiled
   **rn-template** bundle (committed corpus), (c) one **real corpus app**
   (local-corpus, hash-referenced only, output stays local).
3. **Classify every hit** on (a)+(b) and a capped sample on (c) (all hits if
   ≤ 200, else a random 200): `true` (the flagged behaviour is really in the
   program), `artifact` (a decompiler-introduced shape: temp var, duplicated
   guard, helper-internal code), or `oob` (rule class excluded a priori —
   these are removed from the run config, not counted). Classification is
   recorded in `tools/security/semgrep/validation-<date>.json` with file/line
   refs so the reviewer can re-derive it.
4. Apply the adoption bar (below); blocklist failing rules
   (`tools/security/semgrep/blocklist.yaml`, one comment per entry citing the
   validation file).

### 2.4 Adoption bar (numeric)

- **Per rule**: blocklisted if, across the validation runs, it has ≥ 4 hits
  and > 50% of them are `artifact`.
- **Per ruleset**: adopted only if, after blocklisting, (i) surviving rules
  produce ≥ 1 `true` hit class on the seeded fixture or the corpus app, and
  (ii) the surviving artifact-rate is ≤ 30% of remaining hits on the
  validation pair (fixture + rn-template). A ruleset that clears (ii) but not
  (i) is inert here — dropped as dead weight, recorded.
- **Recall floor** (Decision-8, §8.1): the adopted rule config must flag
  ≥ 9/10 seeded classes. A missed class is first met by authoring one of our
  own rules (§2.1) before any thought of a new tool.

### 2.5 Output records

One finding per (rule, site): claim text prefixed **`candidate:`** (spec 12
§3.5 discipline — the tool asserts a pattern match, not a proven vuln),
`severity` mapped from Semgrep rule severity by a fixed documented table
(ERROR→high, WARNING→med, INFO→low; never critical from static pattern alone)
under the indexer-as-analyst-of-record ruling (spec 12 ruling 3), `status:
"open"` always — no self-confirm path, `cwe` copied from rule metadata when
present. Evidence: the target binding/fn id (`role:"match"`) plus `sid:N`
context refs where the rule matched a string. Finding-slot discriminator =
`ruleId` (mirrors spec 12 R3's `patternId`). Provenance:
`prov: { source:"tool", who:"semgrep@<ver>+<ruleset@sha>", run:<invocation id> }`.
`source`/`sink`/`sanitizer` **tags** may be proposed from taint-rule metadata
(tool-proposed, refutable, spec 11 §4.2).

## 3. Lane O — OSV/GHSA matching over `DepsReport`

### 3.1 What runs

Preferred: **`osv-scanner`** (Apache-2.0) in offline-database mode, or the
OSV.dev batch query API (`/v1/querybatch`) directly — the query payload is
`{name, ecosystem:"npm", version}` triples ONLY; no code, no bundle hashes,
no app identity leaves the machine (§6.4). GHSA advisories arrive via OSV's
aggregation; no separate GitHub API dependency and therefore no token.

### 3.2 The false-attribution gate — claim vs candidate

This lane's whole risk is attributing a CVE to an app off a wrong dep guess or
a wrong version. Two-key rule, both required for **claim tier**:

1. **Identity key** — the dep is `matchedDeps` tier **High**, OR a
   `guessedDeps` entry with aggregated confidence **≥ 0.75** and ≥ 2
   independent evidence kinds (the DEPS.md guess-listing floor is 0.5; the
   CVE bar is deliberately higher).
2. **Version key** — the version is *directly evidenced*: an exact-hash match
   against a DB signature pinned to that version, or a `name@version`-shaped
   string literal in the bundle (DEPS.md hint tier), or a confirm-stage exact
   verification. A version resolved by nearest-npm-release-by-date, or
   flagged `usedPrereleaseVersion`, is NOT direct evidence.

Both keys → finding claim text `vulnerable dependency: <pkg>@<ver> matches
<OSV-id>` (still `status:"open"`; "vulnerable dependency" is a statement about
the advisory match, not about reachability — reachability is Stage-3/taint
work). Identity key only, version indirect → **candidate tier**: claim text
`candidate: <pkg> possibly in advisory range of <OSV-id> (version
unevidenced)`, severity capped at `med` regardless of CVSS. Neither key →
no record at all (a Low/hint dep never generates CVE noise).

Tripwire (reviewer ruling 2): if any measured run — fixture, held-out or
corpus — ever surfaces a claim-tier finding whose package is provably absent
from the app, claims resting on a guessed (non-High) identity key demote to
candidate tier repo-wide until a review reinstates them. The two-key gate is
a pre-registered bar, not a proof.

Version-range matching uses OSV's own `affected[].ranges` semver logic (the
scanner or the API does it; we never reimplement semver range math — reuse).

### 3.3 Output records

One finding per (package, advisory): finding-slot discriminator =
`advisoryId` (OSV id). `severity` from CVSS v3 base score by fixed table
(≥ 9.0 critical, 7.0–8.9 high, 4.0–6.9 med, < 4.0 low; absent score → med),
indexer-as-analyst-of-record (spec 12 ruling 3), superseded freely by any
human/LLM record. `cwe` from the advisory when present. Evidence: refs to the
match's anchors — the `mod:N` module ids the dep match attributed
(`role:"match"`), the versioned string literal's `sid:N` when that is the
version key (`role:"context"`). Every ref resolves via `ArtifactService` or
the record is invalid (spec 11 §4.1) — a CVE finding is anchored in the
bundle, not floating. Provenance `who:"osv@<db-date>+deps@<DepsReport hash>"`.

## 4. Lane M — androguard/apktool over the APK

### 4.1 What runs

**androguard** (Apache-2.0, Python; `pipx install androguard`) as the primary
— `AXML`/`APK` API gives manifest facts programmatically. **apktool**
(Apache-2.0) as the cross-check/fallback decoder only. Extracted per APK:

- exported components (activities/services/receivers/providers with
  `exported=true` or an intent-filter, per Android 12 rules),
- permissions requested + custom permissions defined,
- deep-link surfaces: intent-filter schemes/hosts/paths, `autoVerify` links,
- cleartext-traffic + debuggable + backup flags, network security config.

### 4.2 Anchoring — the store demands resolving evidence

Manifest facts are APK-side; spec-11 targets must be bundle ids. Two-tier
landing, honest about anchorability:

1. **Anchored records**: when a manifest fact's string (scheme, host, custom
   permission name, component class string) also occurs in the bundle's
   string table, land a **tag** on that sid — `deeplink` for schemes/hosts,
   `endpoint` for link hosts (both ratified into spec 11 §1.3 by spec 12
   ruling 1), with the manifest path in the tag note — or a finding for
   security-relevant combinations (e.g. exported component + scheme handled
   in JS: claim `candidate: exported deep-link surface <scheme://host>
   handled at sid:N`, severity low/med by fixed table in the impl).
2. **Unanchored facts**: everything else lands in
   `<out>/security/manifest.json` (a derived report file in the project tree,
   NOT a store record) — complete, machine-readable, cited by later human
   findings. This respects evidence-must-resolve instead of faking anchors.

### 4.3 Validation protocol + adoption bar

Ground truth = `aapt2 dump badging` / `xmltree` on the same APK (aapt2 ships
with the Android build tools already present for corpus work; if absent, a
hand-written expected file for the fixture APK). Comparison discipline
(reviewer edit R-M): `aapt2` emits RAW manifest facts, while androguard
computes *effective* exported status under Android-12 defaulting rules that
aapt2 does not apply — so the measure script diffs raw facts (declared
attributes, intent-filter presence, targetSdk) against aapt2, and
effective-exported against the committed hand-verified expected file for the
fixture; it never grades androguard's interpretation against itself. Bar: **100% agreement** on
exported-component list, permission list, and scheme list for the fixture APK,
and 20/20 on a spot-check of one corpus APK. Below 100% on structured facts =
extraction bug, fix or cut — there is no acceptable error rate for reading a
manifest.

## 5. Licensing verdicts (checked 2026-09-03; re-verify at impl, T-L)

| Tool | Licence (verdict) | Use mode |
|---|---|---|
| Semgrep OSS engine | **LGPL-2.1** — subprocess invocation only; we link nothing, copy nothing. Compatible with shipping MIT code that *calls* it. | run |
| Semgrep registry rules | **Semgrep Rules License v1.0** (non-competition clause; NOT open source). Run-time fetch + local cache is permitted use; **vendoring any rule text into this MIT repo is a spec violation** (spec 12 R2 discipline). Our own rules are authored from scratch, citation per rule. | run, never vendor |
| osv-scanner | **Apache-2.0** | run or lib |
| OSV.dev data | **CC-BY 4.0** — attribute in records (`who:"osv@…"` satisfies this; a NOTICE line lands in docs). | data |
| androguard | **Apache-2.0** | run (pipx) |
| apktool | **Apache-2.0** | run |
| CodeQL | GitHub CodeQL Terms: free only for open-source codebases/academic research. Scanning proprietary corpus APKs is outside the grant. **SET ASIDE — licence-unfit**, recorded here per the QUEUE line asking for the licensing/fit check; revisit only under a paid licence decision by Fred. | none |

Reviewer verification (2026-09-03, gate): SPDX ids confirmed hands-on via
the GitHub licence API — semgrep/semgrep `LGPL-2.1`; semgrep/semgrep-rules
`NOASSERTION` (custom licence, consistent with the non-open row);
google/osv-scanner, androguard and Apktool all `Apache-2.0`. The CodeQL row
was not re-fetched (it is SET ASIDE anyway). T-L re-verification (licence
string + URL + retrieval date; mismatch blocks the lane) remains MANDATORY.

Standing rule (P2.3 precedent, spec 12 R2): any AGPL component encountered in
this space (e.g. trufflehog v3) is **behaviour-oracle only** — observe its
verdicts to test ours, never run it as a shipped lane, never copy from it.
T-L (§9 step 0) records each licence string + source URL + retrieval date in
`tools/security/LICENSES.md`; a mismatch with this table blocks the lane.

## 6. Run cost + token cost of consuming output

### 6.1 Per-lane run cost (M5-local, estimates to be measured in T-M)

| Lane | Cold | Warm/incremental |
|---|---|---|
| S: Semgrep, rn-template-scale tree (~4k fns) | ≤ 120 s | ≤ 60 s (ruleset cached) |
| O: OSV, ≤ 100 packages | ≤ 10 s (offline DB) | ≤ 5 s |
| M: androguard, one APK | ≤ 30 s | — |

These are ceilings for the acceptance tests, not aspirations; measured values
land in the report and become the ratchet (spec 12 ruling 2 pattern).

### 6.2 Token cost of USE (the Stage-2 efficiency clause)

Raw tool output (Semgrep JSON can be megabytes) **never enters LLM context**.
The adapter consumes it and writes store records; the loop then uses the
already-bounded spec-11 verbs (`finding list`, `finding show`, `tag list` —
spec 11 §3.1 caps). Marginal new token surface: zero new verbs in v1. A full
security triage first pass = `finding list --prov tool` ≈ one line per
finding ≤ 120 tokens each, expected ≤ 40 findings on an rn-template-scale app
after adoption bars → ≤ ~5k tokens. The unanchored manifest report is read
with `jq`/`grep`, not wholesale.

### 6.3 Determinism / reproducibility

`scan-state` records per lane: tool version, ruleset SHA / OSV DB date,
blocklist hash, DepsReport hash. Re-running with identical state is
idempotent in the store (same slot, same content → no new active record).

### 6.4 Privacy (corpus rule)

local-corpus code/bundles never leave the M5. Semgrep: `--metrics=off`
always. OSV: package-name+version triples only (these are public npm names;
still, a run against a corpus app uses the offline DB by default so not even
the dependency *list* is transmitted). androguard/apktool: fully local. No
lane takes an API key; no lane probes any live endpoint found in the app
(non-goal, §11).

## 7. Record-contract conformance (spec 11, as reviewed)

- Envelope: spec 11 §2.1 verbatim; `rid`/`ts`/`supersedes`/`active`
  writer-assigned; `ctx` captured at write.
- Finding-slot discriminator: `ruleId` (S) / `advisoryId` (O) / manifest fact
  id (M), per spec 12 R3.
- Status: tools write `open` only; no `confirmed` path exists in any lane
  (spec 12 §4.3 precedent). Refuted findings suppress re-assertion on the
  same slot across re-runs (store-driven, spec 12 R1 pattern — the slot key
  survives ruleset bumps because rule/advisory ids are stable, and a renamed
  rule is a new slot by design).
- Severity: fixed documented mappings (§2.5, §3.3), versioned with the
  adapter, indexer-as-analyst-of-record (spec 12 ruling 3).
- Tags: only ratified taxonomy values (`deeplink`, `endpoint`, `source`,
  `sink`, `sanitizer`), all tool-proposed ones provenance-stamped and
  refutable.
- Provenance: `source:"tool"` + tool@version+ruleset/DB identity + run id on
  every record, all lanes.

## 8. Decision-8 quadruples (metric / target / method / held-out)

### 8.1 Lane S (Semgrep)

- **Metric**: seeded-class recall; artifact-rate among classified hits.
- **Target**: recall ≥ 9/10 seeded classes with the adopted config;
  artifact-rate ≤ 30% on the validation pair (post-blocklist).
- **Method**: `tools/security/measure-semgrep.ts` — runs the adopted config
  over the seeded fixture + rn-template tree, joins hits against the
  ground-truth JSON, prints the quadruple; hard numbers in the landing
  report.
- **Held-out**: one real corpus app **never used for blocklist tuning**
  (hash recorded in scan-state with role `held-out`): artifact-rate ≤ 40% on
  the classified sample. A red held-out during tuning triggers
  promote-and-replace (spec 12 R4 pattern), never a quiet blocklist edit
  afterwards.

### 8.2 Lane O (OSV)

- **Metric**: known-advisory recall; false-attribution count at claim tier.
- **Target**: 100% recall of the seeded pins (≥ 3 packages pinned to
  versions with known OSV advisories in the fixture app's lockfile, e.g.
  lodash/axios/old-RN-transitive class — exact pins chosen at impl from the
  OSV DB and recorded in ground truth); **0 claim-tier findings** naming any
  package absent from the fixture lockfile; candidate-tier misattributions
  reported (count in the landing report), not targeted.
- **Method**: build the seeded fixture app with pinned vulnerable versions
  (extends the §2.3 fixture's build), run `deps --json` → OSV adapter;
  `tools/security/measure-osv.ts` compares against the lockfile-derived
  ground truth.
- **Held-out**: the Expensify bundle (`bundles/fetch.sh`; ground truth is
  the dependency closure derived from the upstream *committed lockfile* at
  the fetched tag, fetched once and hash-recorded in scan-state — never
  resolved live from `package.json`): every claim-tier
  finding's package must appear in that dependency closure — asserted, 0
  violations. (react-navigation stays spec 11/12's held-out; using a
  different app avoids piling a third metric on it.)

### 8.3 Lane M (manifest)

- **Metric**: structured-fact agreement vs aapt2 ground truth.
- **Target**: 100% on the fixture APK (components/permissions/schemes);
  20/20 corpus spot-check; 100% of anchored tags' sids resolve.
- **Method**: `tools/security/measure-manifest.ts` diffs androguard-extracted
  facts against `aapt2 dump` (or the committed expected file) for the fixture
  APK in `tests/fixtures/security/vuln-app/apk/` (the committed APK artefact is
  the default, like committed `.hbc` fixtures — reviewer ruling 4; `build.sh`
  regenerates it only where Android build tooling is present, and the gate
  never requires that tooling).
- **Held-out**: one corpus APK, spot-check protocol above.

Ratchet rule for all three (spec 12 ruling 2): after the first measured
landing, the measured value becomes the bar; loosening requires review,
tightening does not.

## 9. Implementation plan (lean-agent-sized, ordered, per-lane CUTTABLE)

| Step | What | Reuse (binding) | Cuttable? |
|---|---|---|---|
| 0 | Licensing verification (T-L → `tools/security/LICENSES.md`), tool-presence probes with actionable install hints (brew/pipx), red acceptance harness `tests/security/` (T1–T8 below, red) | spec 12 step-0 pattern | no (gates all) |
| 1 | Seeded fixture app source + lockfile pins + ground-truth JSON + `build.sh` hook (hbc + APK) | fixture conventions, `tools/get-hermesc.sh` | no (gates S/O/M metrics) |
| 2 | Lane O adapter: `DepsReport` → OSV query → two-key gate → store records; `measure-osv.ts` | `src/deps/report.ts` types, `ProjectService`, osv-scanner | yes (lane) |
| 3 | Lane S runner + hit classifier scaffolding + validation runs + blocklist + our-rules for missed seeds; `measure-semgrep.ts` | Semgrep CLI, `ProjectService` | yes (lane); taint sub-lane separately cuttable |
| 4 | Lane M: androguard extraction → anchored tags/findings + `security/manifest.json`; `measure-manifest.ts` | androguard, `ArtifactService` sid lookup | yes (lane) |
| 5 | Landing: measured quadruples, scan-state, docs (STATUS/DEPS cross-ref, NOTICE line), BUGS rows for anything cut | — | no |

Steps 2/3/4 are independent after 0–1 and may run as separate lean agents.
"Cuttable" means: the lane lands nothing, its cut is recorded with the
validation data that failed the bar — never a lane shipped below its bar.

## 10. Acceptance tests (tests/security/, step 0 lands them red)

Pre-impl-runnable now: T-L, T1, T2. The rest are precisely specified and land
red in step 0 (spec 12 step-0 precedent satisfies tests-before-impl).

- **T-L licensing**: `LICENSES.md` exists, contains an entry per §5 row with
  URL + date; asserts no file under `tools/security/semgrep/` textually
  matches any cached registry rule id header (anti-vendoring tripwire).
- **T1 fixture integrity**: ground-truth JSON lists ≥ 10 seed classes, each
  seed comment present in fixture source; lockfile contains the ≥ 3 pinned
  advisory versions; fixture `.hbc` decompiles through the real pipeline.
- **T2 two-key gate (pure)**: unit-test the claim/candidate classifier on a
  fabricated `DepsReport`: High+direct-version → claim; High+date-inferred
  version → candidate; confidence 0.6 guess + versioned literal → candidate
  (identity key fails); Low/hint → no record. No network.
- **T3 lane-O recall**: measure-osv on the fixture = 100% seeded recall, 0
  claim-tier off-lockfile findings (network-free via committed OSV DB
  slice for the pinned packages, committed with its CC-BY 4.0 attribution
  header; the full offline DB is a local resource like tools/hermesc).
- **T4 record conformance**: every lane-written record resolves all evidence
  via `ArtifactService` re-check; provenance fields present; claim text of
  every candidate-tier finding starts `candidate:`; no tool record has
  status other than `open`.
- **T5 idempotency + refutation**: re-run adapter with identical scan-state →
  0 new active records; refute one finding, re-run → stays refuted.
- **T6 lane-S recall**: measure-semgrep on the fixture ≥ 9/10 classes
  (skipped-with-reason when semgrep binary absent; `HBC2JS_REQUIRE_ORACLES=1`
  turns the skip into a failure, existing convention).
- **T7 lane-S artifact bar**: validation JSON exists, every hit classified,
  computed artifact-rate ≤ 30% on the pair; blocklist entries each cite it.
- **T8 lane-M agreement**: extracted facts == expected file for the fixture
  APK; every anchored tag's sid resolves; unanchored facts all present in
  `security/manifest.json`.

Held-out assertions (S artifact-rate, O Expensify-closure, M spot-check) run
in `measure-*` scripts and land as numbers in the report, not in the gate
(corpus data is not in the repo).

## 11. Non-goals (v1)

- **No network probing of anything found in an app** — no key validation, no
  endpoint liveness checks, no auto-exploit. Findings state matches, never
  test them against live systems.
- **No disclosure/report document format** — P2.7 (spec 11 §1.6 reserves it).
- **No CodeQL** (§5), **no Frida** (its own later spec), **no plain-JS
  (non-Hermes) bundle support** (D18).
- **No reachability claims** from lane O — "app contains vulnerable version"
  is the claim ceiling; connecting advisories to call paths is Stage-3/taint.
- **No new store verbs, no new record kinds.**
- **No deb-box dependency** — all lanes run on the M5.

## 12. Open questions for the reviewer

1. **Semgrep Rules License posture** (§5): is run-time-fetch-never-vendor an
   acceptable dependency for a shipped lane, or must the adopted config be
   only our own MIT rules (registry rules demoted to a local validation
   oracle)? Spec author recommends run-time-fetch with the SHA pin; the
   non-competition clause plausibly does not reach "an analyst runs semgrep
   locally", but it is a judgement call worth a ruling.
2. **Claim-tier wording** (§3.2): is `vulnerable dependency: …` (no
   `candidate:` prefix) acceptable at claim tier given both keys, or should
   every tool finding carry the prefix and let only humans remove it?
3. **Lane-O held-out choice** (§8.2): Expensify-closure containment instead
   of react-navigation — fine, or standardise all Stage-2 held-outs on one
   app?
4. **Fixture APK in-repo** (§8.3): committing a small built APK artefact
   (like committed `.hbc` files) vs requiring Android build tooling in
   `build.sh` — which default?
5. **Adoption-bar numbers** (§2.4): 30%/40% artifact-rate and the ≥4-hit/50%
   per-rule blocklist threshold are pre-registered folklore, spec 12
   ruling-2 style — accept as starting ratchets?

## 13. Review responses

### Review responses (2026-09-03, Fable reviewer gate)

**VERDICT: APPROVED.** Implementation may launch at step 0 (§9); lane O
(step 2) implements first after steps 0–1. Every issue found was fixed by a
small in-place reviewer edit (marked R-* below) plus the five rulings. No
CHANGES REQUIRED items remain.

**Checklist findings**

1. *Decision-8 quadruples (§8)*: complete and sane, all three lanes —
   metric / numeric target / measure script / held-out present. The two bars
   the gate was told to stress-test hold up:
   - **Lane M 100%-or-cut**: the measurement CAN distinguish pass from fail
     because "structured fact" is an enumerable set diff (exported-component
     list, permission list, scheme list) against an independent extractor —
     but only after edit **R-M** (§4.3): `aapt2` emits raw manifest facts
     while androguard computes *effective* exported status under Android-12
     defaulting, so a naive diff would either mis-fail correct extraction or
     silently grade androguard against itself. The measure script now diffs
     raw facts vs aapt2 and effective-exported vs the committed hand-verified
     expected file. With that split, 100% is the right bar: manifest reading
     is deterministic parsing, and any disagreement is a bug.
   - **Lane O 0-false-attribution**: distinguishable because ground truth is
     a concrete package set in both places — the fixture's own lockfile
     (we author it), and for the held-out the closure derived from
     Expensify's upstream *committed lockfile* at the fetched tag (edit
     **R-O**: closure from the lockfile, hash-recorded, never resolved live
     from `package.json`, which would need network resolution at measure
     time and be non-reproducible). "Off-lockfile" = claim-tier finding
     naming a package outside that set; a membership check, no judgement
     call. Candidate-tier misattributions are counted, not targeted — right,
     since candidate language already discounts them.
   - Lane S recall (9/10 seeded) is deterministic against the ground-truth
     JSON; artifact-rate depends on the recorded per-hit classification,
     which §2.3.3 makes re-derivable (file/line refs) — auditable, accepted.
2. *Licensing rows (§5)*: verified hands-on this gate via the GitHub licence
   API (recorded in §5): semgrep/semgrep `LGPL-2.1`, semgrep-rules
   `NOASSERTION` (custom licence — consistent with the Semgrep Rules License
   v1.0 non-open row), osv-scanner / androguard / Apktool `Apache-2.0`. All
   rows as claimed. CodeQL terms not re-fetched; the row is SET ASIDE anyway
   and its posture (free grant excludes proprietary-corpus scanning) matches
   reviewer knowledge. T-L re-verification with URL + retrieval date remains
   MANDATORY and lane-blocking on mismatch (§5 wording confirmed).
3. *Truth posture*: consistent with specs 11/12 as reviewed. All lane-S and
   lane-M findings carry `candidate:`; lane-O claim tier is ruled on below
   (ruling 2). No self-confirm path in any lane; `status:"open"` only;
   refutation suppression is store-driven off stable slot keys
   (`ruleId`/`advisoryId`), the spec-12 R1 pattern applied correctly.
   Severity mappings are fixed, documented, versioned with the adapter,
   under spec 12 ruling 3 (indexer-as-analyst-of-record). Unanchorable
   manifest facts go to a derived report file, never fake-anchored — the
   honest reading of spec 11 §4.1. The §7 tag list (`deeplink`, `endpoint`,
   `source`, `sink`, `sanitizer`) is verified all-ratified: the first two by
   spec 12 ruling 1, the last three in spec 11 §1.3's v1 taxonomy — no new
   ratification needed from this gate.
4. *Efficiency*: raw tool JSON never enters LLM context; consumption is via
   spec-11 capped verbs; zero new verbs. ≤ ~5k-token first triage pass is a
   stated budget in the spec-12 style. Run-cost ceilings (§6.1) become
   ratchets after first measurement (ruling 5 pattern). Sound.
5. *Implementation plan (§9)*: per-lane cuttable is real (steps 2/3/4 land
   nothing if their bar fails, with the failing data recorded), steps are
   lean-agent-sized, and the order is right. **Lane O first**: smallest
   surface, pure two-key gate logic testable without network (T2/T3),
   exercises the store contract end-to-end cheapest, and its fixture needs
   (lockfile pins) ride the step-1 fixture anyway. Lane S is the largest and
   noisiest (validation/classification loop); lane M last as the only lane
   touching non-bundle inputs. Step 0's red acceptance tests satisfy
   tests-before-implementation (spec 12 step-0 precedent).

**Rulings on the §12 open questions**

1. **Registry rules: run-time-fetch-never-vendor ACCEPTED for the shipped
   lane.** The Semgrep Rules License restricts *competing use* and
   redistribution; an analyst's local semgrep run fetching rules through
   semgrep's own client, cached in `~/.semgrep`, with nothing entering this
   MIT repo, is ordinary permitted use — the same posture every semgrep CLI
   user has. Conditions already in the spec and confirmed binding: SHA pin
   in scan-state; T-L anti-vendoring tripwire (no file under
   `tools/security/semgrep/` matching a cached registry rule); a T-L licence
   mismatch blocks the lane. §2.4's recall floor already routes missed
   classes to our own MIT rules first, so a future forced demotion of
   registry rules to validation-oracle-only degrades, not breaks, the lane.
2. **Claim-tier wording ACCEPTED: no `candidate:` prefix when both keys
   hold.** The un-prefixed claim asserts exactly what was verified — an
   advisory-range match on an evidenced version of an evidenced package —
   and explicitly not reachability. Blanket-prefixing everything would
   erase the two-key distinction the lane exists to draw, and the
   falsifiable check is the 0-off-lockfile target plus the held-out
   containment assertion. Condition (edit **R-T**, §3.2): a demotion
   tripwire — any measured claim-tier misattribution anywhere demotes
   guessed-identity (non-High) claims to candidate tier repo-wide pending
   review. Truth stays protected by measurement, not by hedging every
   sentence.
3. **Expensify as lane-O held-out ACCEPTED; do not standardise on one
   app.** react-navigation already carries spec 11's and spec 12's held-out
   metrics; a single universal held-out concentrates correlated
   tuning-contact risk and makes promote-and-replace (spec 12 R4) a
   three-spec event. Lane O additionally needs a public committed lockfile
   at a pinned tag for its ground truth, which Expensify provides. Corpus
   roles in scan-state keep the assignment auditable.
4. **Fixture APK: COMMIT the built artefact; never require Android build
   tooling.** Exact `.hbc` precedent — the gate must run on a bare
   macOS/Linux checkout (repo hard rule), and Android SDK presence is the
   opposite of that. `build.sh` regenerates the APK only where tooling
   exists; provenance (build inputs, tool versions) recorded next to the
   artefact so it is reproducible, not magic. Edit **R-A** (§8.3) pins this
   as the default rather than the fallback.
5. **Adoption-bar numbers ACCEPTED as pre-registered starting ratchets**
   (30% pair / 40% held-out artifact-rate; ≥ 4-hit → > 50%-artifact per-rule
   blocklist). Admitted folklore, but Decision-8 wants a falsifiable
   pre-registered bar, not a proven-optimal one — exactly the spec 12
   ruling-2 posture. First measured landing becomes the bar; loosening
   requires review, tightening does not. The per-rule ≥ 4-hit floor
   correctly avoids blocklisting on 1–3 hit noise.

**Edits applied (in place)**

- **R-M** (§4.3): raw-facts-vs-aapt2 / effective-exported-vs-expected-file
  comparison split, so the 100% bar measures extraction, not interpretation.
- **R-O** (§8.2): held-out closure derived from Expensify's committed
  lockfile at the fetched tag, hash-recorded; never live-resolved.
- **R-T** (§3.2): claim-tier demotion tripwire on any measured
  misattribution.
- **R-A** (§8.3): committed fixture APK is the default; gate never requires
  Android build tooling.
- **R-V** (§5): hands-on licence verification results recorded; T-L
  mandatory re-verification confirmed blocking.
- **R-N** (§10 T3): committed OSV DB slice carries its CC-BY 4.0
  attribution header.
- Status line updated to gate-passed.
