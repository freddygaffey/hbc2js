# 11 — The project store: versioned analyst/LLM annotations over the artifact (P2.2)

> Status: SPEC (design only). Nothing built yet. This generalizes the Design-D
> naming overlay (`docs/specs/rename-tool-DESIGN-D-overlay.md`) into hbc2js's
> Ghidra-project / IDA-db equivalent, and attaches to the artifact directory and
> index defined in `docs/specs/10-artifact-format.md` (P2.1). The naming overlay
> becomes ONE record type inside it.

Reading list: `docs/AGENT-BRIEF.md`; `docs/specs/rename-tool-DESIGN-D-overlay.md`
(the overlay this generalizes); `docs/specs/10-artifact-format.md` §1 (layout),
§3 (query surface + token bounds), §4 (truth guarantees), §5 (decision-8);
`src/name-overlay/{store,id,service}.ts` (the engine and ids reused verbatim).

## 0. Where this sits in the pipeline

The artifact (spec 10) is the immutable, recomputable, binary-derived TRUTH about
a bundle: rendered tree + index keyed to `fnIndex` / binding ids. The **project
store is the mutable analyst layer that sits beside it** — everything a human or
LLM *asserts* about the target while working: names (already shipped as the
overlay), comments, tags, bookmarks, findings. It never alters the artifact and
never alters rendered code semantics; like the overlay, it is a display-layer
annotation keyed to the same stable ids.

The success criteria are Stage-2's, IN ORDER (QUEUE STAGE 2):
1. **TRUTH.** An annotation is faithful to the ids it names, or it is flagged
   invalid — never silently applied, never silently dropped. A finding is never
   free text: it carries evidence refs that must RESOLVE. Nothing here changes
   what the code does or how it renders semantically.
2. **EFFICIENT TO USE.** Each operation is cheap to interact with: scoped reads
   (annotations-for-one-fn, findings-by-tag) with per-verb token bounds, a warm
   resident service, no whole-store dumps. This is not token rationing; it is not
   wasting context on re-parses and over-broad reads.

## 1. Record types (v1)

Every record, whatever its type, shares a common envelope (§2.1) and is keyed to
a canonical binding id string from `src/name-overlay/id.ts` (`bindingKey`) OR to
a bare `fnIndex`, string id (`sid`), or module id — the SAME id vocabulary the
artifact index uses. No record invents its own addressing.

### 1.1 `names` — the naming overlay (reused, WRAPPED not migrated)

The Design-D overlay is unchanged: `src/name-overlay/store.ts`, the shipped
`hbc2js name <set|get|revert|search|list|context>` CLI, and its on-disk file
(`<hbc>.names.json`, or `--store <path>`) all keep working exactly as today. The
project store does NOT move that data or rewrite that format (see §2.4 for the
migrate-vs-wrap ruling). It presents `names` as one record type through the
unified query/service surface (§3) by delegating to the existing `OverlayStore`.
The append-only supersession/revert engine that overlay already implements is the
model every other record type follows (§2).

### 1.2 `comments` — free-text notes anchored to code

- **fn-level:** `{ target: "fn:42", body: "<markdown>" }`.
- **site-level:** `{ target: "fn:42", range: {line:130,col?}, body }` — a note on
  a specific rendered line. The `range` is resolved against `ranges.jsonl`
  (spec 10 §2.7), the render-coupled presentation layer, so a comment survives a
  re-render as long as its `fn:42` binding survives; if only the line moved, the
  comment re-anchors to the fn and is flagged `range-stale` (never dropped).
- Comments are the one record type allowed to be pure prose. They assert nothing
  checkable, so they carry provenance but no evidence requirement.

### 1.3 `tags` — a controlled taxonomy on a binding

`{ target: <id>, tag: <enum>, note?: <short> }`. v1 starter taxonomy (closed set,
schema-versioned; additions are a reviewed commit like spec 10 §2.5's host-global
list):

| tag | meaning |
|---|---|
| `source` | untrusted input enters here (network, IPC, storage, user) |
| `sink` | dangerous operation (eval, exec, SQL/HTML/path build, native bridge) |
| `sanitizer` | validates/escapes/normalizes data crossing source→sink |
| `reviewed` | a human/LLM has read this and stands behind it |
| `suspicious` | worth a second look; not yet a finding |
| `provably-dead` | unreachable (feeds Stage-3 dead-code = ANNOTATE, below) |
| `attacker-reachable` | reachable from a `source` per the call graph |

Stage-3's dead-code decision is ANNOTATE, not delete (QUEUE STAGE 3): dead code
gets a `provably-dead` tag in THIS store, with evidence (the reachability
argument), rather than being removed from the render. `attacker-reachable` and
`provably-dead` are the two tags a tool may *propose* mechanically (from the call
graph / CFG); every mechanical proposal still carries provenance (§4.2) and is
refutable. All other tags are asserted by human/LLM judgement.

### 1.4 `bookmarks` — navigation markers

`{ target: <id>, label?: <short> }`. No semantics beyond "come back here";
cheapest record type. Exists so the loop can build a worklist without abusing
comments or tags.

### 1.5 `findings` — structured claims (never free text alone)

The point of the whole environment. A finding is a **structured claim with
resolving evidence**, never prose:

```json
{ "kind": "finding",
  "claim": "user-controlled response flows into eval without sanitization",
  "severity": "low|med|high|critical",
  "target": "fn:42",
  "evidence": [
    { "ref": "fn:42/reg:7", "role": "source" },
    { "ref": "fn:57", "role": "sink" },
    { "ref": "sid:1203", "role": "context" },
    { "ref": "trace:campaign1/seed-777007", "role": "dynamic" },
    { "ref": "fuzz:tests/fixtures/adversarial/43-…", "role": "repro" }
  ],
  "status": "open|confirmed|refuted",
  "cwe?": "CWE-95" }
```

- **Every finding REQUIRES ≥1 evidence ref, and every ref must RESOLVE** (§4.1):
  a binding id present in the artifact index, a valid `sid`/module id, or a
  named trace/fuzz artifact that exists. A finding whose evidence points at a
  stale or absent id is flagged `invalid` and excluded from active queries until
  fixed — it is never shown as a live finding.
- `status` transitions are themselves records (append-only): open→confirmed
  needs `confirmed`-role evidence (a trace/fuzz/repro ref, not just static); a
  finding can be `refuted` with counter-evidence. The transition is stamped with
  provenance (§4.2).
- Severity is analyst-assigned; the store does not compute it.

### 1.6 What v1 EXCLUDES

- **Type/shape recovery, protocol/wire-format records** — reserved for the
  artifact index's `shapes.jsonl` extension (spec 10 §6), not the project store.
- **The disclosure/report FORMAT** (turning confirmed findings into a writeup) —
  a P2.7 consumer of this store, specced separately.
- **Multi-user real-time concurrent editing** — the merge story (§2.3) is
  last-writer-with-conflict-record, not live collaborative editing.
- **Cross-app-version identity re-binding** — orphan FLAGGING is here (§2.5);
  actually re-matching a vanished id to its successor is P2.5's version-diff job.
- **Automatic tag inference beyond `provably-dead`/`attacker-reachable`** — no
  ML taint engine in v1; Semgrep/OSV integration is P2.4 and writes findings
  THROUGH this store's API, it is not part of v1.
- **Writing anything back into the `.hbc`** — same hard rule as the overlay.

## 2. Store design

### 2.1 Common record envelope

Every record, all types, shares the overlay's proven shape (`NameRecord` in
`src/name-overlay/store.ts` is the template):

```json
{ "rid": "<store-local monotonic id>",
  "kind": "name|comment|tag|bookmark|finding|status",
  "target": "<bindingKey | fnIndex | sid:N | mod:N>",
  "prov": { "source": "human|llm|tool", "who": "<agent/run id | user>",
            "run?": "<llm run id or tool invocation id>" },
  "ts": "<iso>",
  "supersedes": "<prior rid | null>",
  "active": true,
  "ctx": { "name?": "<target's overlay/recovered name at write time>",
           "loc?": "<file:line>", "ownerFn?": "<owning-fn signature>" },
  "…type-specific fields…" }
```

- **Append-only revisions, revertable** — identical to Design-D §4/§9: a new
  record for the same `(kind,target[,tag])` slot *supersedes* rather than
  overwrites; the full timeline is retained; `revert` re-activates a prior
  record or clears the slot. This is the ONE piece of machinery every record
  type shares, and it already exists.

### 2.2 On-disk format and location

The project store lives INSIDE the artifact directory (spec 10 §1), one JSONL
file per record type, so it grows around the same directory the naming overlay
sidecar already sits beside:

```
<artifact>/
  manifest.json
  index/…
  overlay/
    names.jsonl        # the overlay (spec 10 §1 already reserves this)
  project/
    comments.jsonl
    tags.jsonl
    bookmarks.jsonl
    findings.jsonl     # includes status-transition records
    project.json       # store header: schema, seq counters, builtFor (bundle sha)
```

- **JSONL, one record per line**, sorted by `(target, rid)` — same rationale as
  spec 10 §1.1: grep-able, streamable, and P2.5 diffs two project stores as line
  diffs. First line of each file is a schema header
  `{"schema":"hbc2js-project/1","kind":"tags"}`; unknown major schema = refuse.
- `project.json` records the `builtFor.bundleSha256` (from the artifact
  manifest) so the store knows which decompile it annotates (feeds §2.5).
- **Names stay where they are** (§2.4): `overlay/names.jsonl` OR the legacy
  `<hbc>.names.json` — the project store reads them through `OverlayStore`, it
  does not duplicate them under `project/`.

### 2.3 Merge / conflict (two sessions annotating one target)

- Append-only + per-record `rid` makes concurrent stores mergeable: the merge is
  a **line union** of the JSONL files, re-sorted by `(target, rid)`. Two sessions
  that added different records never conflict.
- A **slot conflict** (both sessions superseded the same active record) is not
  resolved silently: the merge keeps BOTH new records and writes a
  `conflict`-kind record referencing the two `rid`s; the slot is marked
  `contested` and surfaced by `project conflicts` until an analyst resolves it
  with a new superseding record. Truth over convenience: the tool never guesses
  which analyst was right.
- **Precondition: both stores' `builtFor.bundleSha256` match** (ruling on §9
  Q4): the merge is refused otherwise. This is a truth requirement, not
  tidiness — across different decompiles the same `fn:N` can resolve to a
  DIFFERENT function, so merged records would not merely orphan, they would
  silently re-attach to the wrong code, which no orphan check can catch.
  Cross-version reconciliation is P2.5's job.
- v1 merge is a batch CLI operation (`project merge <other-store>`), not live.

### 2.4 DECISION — overlay migrate vs wrap: WRAP (share the engine, keep the data)

The shipped `name` CLI and `<hbc>.names.json` format are a live contract; Stage-2
truth rule forbids breaking a shipped contract for tidiness. Therefore:

- **Data: WRAP.** Names stay in their existing file/format. The project store
  exposes `names` as a record type by delegating to `OverlayStore`, not by
  copying rows into `project/`. No migration step, no back-compat break, the
  `name` subcommand is untouched.
- **Engine: SHARE.** The append-only supersession/revert/search logic in
  `OverlayStore` is extracted into a generic `RevisionStore<T extends Record>`
  (records with `rid`/`supersedes`/`active`), and `OverlayStore` becomes a thin
  instance of it. Comments/tags/bookmarks/findings are new `RevisionStore`
  instances over their own files. This is a refactor-with-no-behaviour-change of
  the overlay (guarded by the overlay's own acceptance tests staying green) plus
  new record-type modules — NOT a rewrite.

### 2.5 Id stability across re-decompiles, and the orphan policy

- **Survives when binding ids survive.** Because targets are binary-derived ids
  (spec 10: stable across re-render and across re-decompile of the SAME bytes),
  a re-render or same-bytes re-decompile re-applies every annotation unchanged —
  exactly the overlay's property (Design-D §11 test 1), now for all record types.
- **New app version (`fnIndex` NOT stable across versions — spec 10 §6).** When
  a re-decompile is of DIFFERENT bytes, some targets no longer resolve. **Policy:
  orphaned annotations are FLAGGED, never dropped.** On load against an artifact
  whose `builtFor` differs, the store resolves every `target` against the new
  index; a record whose target is absent is reported `orphaned` — a
  **live-computed** status (§3.3), never a mutation of the stored line
  (append-only holds; the record itself is untouched). Its **last-known
  context** is the `ctx` snapshot (§2.1) captured at WRITE time — the target's
  then-current name / file:line / owning-fn signature — so P2.5 can attempt
  re-binding without the old artifact. (Reviewer edit E1: the spec previously
  said the record was "marked", which contradicted §3.3 live-computation and
  append-only.) Orphaned records:
  - are EXCLUDED from render and from active/`for-fn` queries (they no longer
    describe live code),
  - are RETURNED by `project orphans` and counted in `project stat`,
  - are the input to P2.5 version-diff, which owns the actual re-attachment.
  A silently dropped annotation would be a lost finding — the worst Stage-2
  failure. Flag-never-drop is the rule.

## 3. Query / write surface

Mirrors spec 10 §3: the JSONL files ARE the contract (a tool streaming
everything reads them directly); on top, one front-end in two forms sharing one
implementation — a **resident `ProjectService`** (primary for the loop, follows
`ArtifactService`/`NameService`: parse/load once, stay warm) and a thin
`hbc2js project <verb>` CLI (one-offs, tests, humans; listed in `--help`).

### 3.1 Verbs and their TOKEN COST OF USE (hard bounds)

Stage-2 output contract restated: **reads are scoped — never a whole-store dump.**
Every answer is ids + one-line facts + ranges; when a cap truncates, the output
SAYS so (`… 40 more; use --all/--page`). Default caps; `--all` pages.

| verb | answer shape | bound (default) |
|---|---|---|
| `project for-fn <fn>` | all annotations on `fn:N` and its regs/env: one line each `tag source@llm-run3`, `comment L130 "…head"`, `finding#12 high open` | ≤ 40 lines + total |
| `project tag set <id> <tag> [--note]` | one line: `tagged fn:42/reg:7 source [llm-run3]` | 1 line |
| `project tag get <id>` | active tags on id, one/line | ≤ 10 lines |
| `project findings [--tag t] [--severity s] [--status open]` | one line per finding: `#12 high open fn:42 "claim head" ev:3` | ≤ 50 lines + total |
| `project finding show <id>` | the full finding record + evidence resolution status | ≤ 20 lines |
| `project finding set-status <id> <status> --evidence <ref…>` | one line confirmation | 1 line |
| `project comment add <target> [--range L] --body <s>` | one line | 1 line |
| `project comments <fn>` | comments on a fn, one head-line each | ≤ 30 lines + total |
| `project bookmarks [--fn N]` | bookmark rows | ≤ 50 lines + total |
| `project orphans` | orphaned records with last-known context | ≤ 50 lines + total |
| `project conflicts` | contested slots (§2.3) | ≤ 50 lines + total |
| `project stat` | counts per record type + orphan/conflict/invalid-finding totals | ≤ 15 lines |

`names` verbs are the existing `hbc2js name …` set (Design-D §5), unchanged and
served by the same warm process. `project for-fn` is the one aggregating read the
loop leans on: everything asserted about a function in one bounded answer, so the
LLM never dumps the store to see what it already knows about the code in front of
it.

### 3.2 Service API (mirrors the verbs; the loop imports this)

```ts
class ProjectService {
  constructor(artifactDir: string, artifact: ArtifactService) // shares the warm index
  forFn(fn: number, page?): AnnotationRow[]     // bounded union across record types
  tags(id: BindingId): TagRecord[]
  setTag(id: BindingId, tag: Tag, prov: Prov, note?): SetResult
  findings(q: FindingQuery, page?): FindingRow[]
  finding(id: string): FindingRecord               // with per-ref resolution status
  setFindingStatus(id, status, evidence: Ref[], prov): SetResult   // validates refs
  addComment(target, body, prov, range?): SetResult
  bookmarks(q?, page?): BookmarkRecord[]
  orphans(page?): OrphanRow[]
  conflicts(page?): ConflictRow[]
}
```

Every method returns an already-bounded row set. There is no "give me the whole
store" method — a tool that needs everything reads the JSONL (cheaper both
sides). `setTag`/`addComment`/`setFinding*` are the write verbs; each resolves
its refs against the shared `ArtifactService` BEFORE accepting the write (§4.1).

### 3.3 Live vs materialised

Materialised on disk: every record (they are analyst-authored, not
recomputable). Computed live from the warm artifact index at query time:
evidence-ref RESOLUTION status, orphan detection, and `for-fn` aggregation —
these depend on the current artifact, not on the stored bytes, so they are never
cached into the store.

## 4. Truth guarantees

### 4.1 Evidence must resolve; a finding without resolving evidence is invalid

- On WRITE, `ProjectService` resolves every evidence `ref` against the shared
  `ArtifactService` (binding id → index; `sid:` → string table; `mod:` → module
  graph) and against the trace/fuzz artifact store (a `trace:`/`fuzz:` ref must
  name an artifact that exists). A finding with zero resolving refs is REJECTED
  at write time (findings are never free text — §1.5).
- On READ, resolution is re-checked live (§3.3): a previously-valid finding whose
  target/evidence has since gone stale (re-decompile) is returned with
  `valid:false` and EXCLUDED from active `project findings` output until fixed.
  A finding pointing at a stale/absent id is flagged invalid, never shown live.
- `open→confirmed` additionally requires ≥1 evidence ref of a *dynamic* role
  (`trace`/`fuzz`/`repro`) — a static-only claim cannot self-promote to
  confirmed. This is the decompilation-fidelity guard: a "bug" that only exists
  in the static render, never reproduced, stays `open`.

### 4.2 Provenance is mandatory

Every record's `prov` (who/what asserted it: `human` with user id, `llm` with a
run id, `tool` with an invocation id) is a required field, not optional — the
same audit-trail discipline the overlay enforces for names (Design-D §6). A tag,
comment or finding with no provenance is not writable. Mechanically-proposed tags
(`provably-dead`, `attacker-reachable`) are stamped `source:"tool"` with the
producing tool/run, so a human proposal and a tool proposal are always
distinguishable and independently refutable.

### 4.3 Display-layer only

Nothing in the project store ever alters rendered code SEMANTICS. Names
alpha-rename at render (Design-D §7, unchanged). Comments surface through the
query layer by default; rendering them into code is an **opt-in derived view**
(`hbc2js render --with-comments`) that is never the canonical render — the
canonical, `ranges.jsonl`/`renderHash`-bearing render (spec 10 §4.2) is a
function of binary + names overlay ONLY and is byte-identical for every
project-store record type, comments included. (Reviewer edit E2: comments in
the canonical render would shift line numbers on every `comment add`, staling
`ranges.jsonl` outside spec 10's overlayHash staleness model, which has no
project-store hash.) Tags/bookmarks/findings do not render into code at all
(they surface through the query layer and any future report format). There is no code path by which a
project-store record changes what the emitted JS computes — the same
by-construction guarantee the overlay gives.

## 5. Decision-8 quadruple (metric / target / method / held-out)

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Annotation integrity**: fraction of active (non-orphaned) records whose target + evidence refs all resolve against the artifact, over a seeded corpus of writes replayed on rn-template | **100%** (a live annotation that doesn't resolve is a truth bug); orphan-rate is *reported*, not targeted, but 100% of orphans must carry last-known context | `tools/project/check-store.ts --seed 1` replays a fixture write-log, then resolves every active record; also asserts 0 findings with `valid:true` but unresolved evidence |
| 2 | **Read token cost**: bytes/lines per answer over the fixed verb corpus (every verb × 20 sampled args) | every answer within its §3.1 cap; median `for-fn` ≤ 1.5 KB; `finding show` ≤ 20 lines always; NO verb ever emits a whole-store dump | `tools/project/measure.ts` runs the corpus, emits max/median per verb |
| 3 | **Run cost**: store load+resolve wall-time as a fraction of `ArtifactService` construction (must be a thin add-on to an already-warm index); on-disk store size vs a bounded per-record budget | store load+resolve ≤ 15% of artifact-index load time; ≤ 300 bytes/record median on disk | same `measure.ts`, best-of-3, on rn-template + held-out |
| 4 | **Held-out check** | targets 1–3 hold on a bundle never used while building the store engine, AND the orphan policy fires correctly across a real version bump | build/tune on rn-template + construct fixtures; **measure on react-navigation (`fetch.sh`)**; for orphans, annotate rn-template v0.72 then load the SAME store against a re-fetched newer rn-template (or a mutated-bytes artifact; the landing report states which was used) and assert every vanished id becomes a flagged orphan with context, zero silent drops |

`measure.ts` prints one summary block; the acceptance suite (§6) asserts targets
1–2 in `test:all`; the implementer's landing report states all four numbers plus
the per-operation token bounds actually observed.

## 6. Acceptance tests

P1–P3 are the pre-implementation-runnable acceptance tests: precisely
specified here and committed as impl-plan **step 0** (§7) — a tests-only red
harness on a hand-written sample store (like spec 10's A1) that lands BEFORE
any implementation step. (Reviewer edit E5: the spec commit itself, a237fe8,
was docs-only; step 0 owns shipping them, satisfying the spec-agent-writes-
acceptance-tests rule since step 0 precedes all code.) The rest are precisely
specified for the implementer.

- **P1 (pre-impl, hand-written sample): envelope + schema self-consistency**
  (`tests/project/format-schema.test.ts`). Every record has the §2.1 envelope;
  every file has a schema header; unknown schema is refused; rows sorted by
  `(target, rid)`.
- **P2 (pre-impl): finding requires resolving evidence.** A finding with zero
  evidence refs is rejected; a finding whose only refs are unknown ids is
  rejected; a finding with one resolving ref is accepted. Runnable against a mock
  `ArtifactService` resolver.
- **P3 (pre-impl): append-only supersession + revert** on a non-name record
  (tag), reusing the overlay's own supersession test shape — proves the extracted
  `RevisionStore` engine behaves identically for a new record type.
- **A-WRAP overlay unchanged** (`tests/name-overlay/*` must stay green after the
  `RevisionStore` extraction): the refactor is behaviour-preserving; the shipped
  `name` CLI and `<hbc>.names.json` format are byte-identical. Test-count must not
  drop (project CLAUDE.md rule).
- **A-ORPHAN** (`tests/project/orphan.test.ts`): annotate an artifact, load the
  store against an artifact with a different `builtFor` where a target id is
  absent → that record becomes `orphaned` with last-known context, is excluded
  from `for-fn`, and appears in `project orphans`. Assert ZERO records dropped.
- **A-CONFLICT** (`tests/project/merge.test.ts`): two divergent stores merged →
  line union; a same-slot double-supersede produces a `conflict` record and a
  `contested` slot in `project conflicts`; no silent pick.
- **A-STATUS** (`tests/project/finding-status.test.ts`): `open→confirmed` refused
  without a dynamic-role evidence ref; accepted with one; `refuted` needs
  counter-evidence; each transition is an append-only record with provenance.
- **A-DISPLAY** (`tests/project/display.test.ts`): canonical render
  before/after writing every non-name record type — comments included — is
  byte-identical (§4.3, reviewer edit E2); comments appear only in the opt-in
  `--with-comments` view; tags/bookmarks/findings never appear in rendered
  code in either view.
- **A-BOUNDS** (`tests/project/query-bounds.test.ts`): every §3.1 verb on
  rn-template stays within its cap and truncation is announced.
- **A-PROV** (`tests/project/provenance.test.ts`): a write with no `prov` is
  rejected; a mechanical `provably-dead` tag is stamped `source:"tool"`.
- **A-MEASURE** (`tests/project/targets.test.ts`, in `test:all`, oracle-gated):
  the decision-8 §5 targets 1–3.

Testing-rule compliance (project CLAUDE.md / CONSOLIDATION §B): these are
rung-owned property/structural/bounds assertions on project-store-private
fixtures — NO exact-output string assertion against a shared
`tests/fixtures/constructs/**` decompile.

## 7. Implementation plan (lean-agent-sized, ordered; reuse column is binding)

| step | delivers | reuses | new |
|---|---|---|---|
| 0 | P1–P3 red harness + hand-written sample store, committed | overlay test shapes | `tests/project/*` |
| 1 | extract `RevisionStore<T>` from `OverlayStore` (behaviour-preserving); `OverlayStore` becomes an instance; A-WRAP + overlay tests green | `src/name-overlay/store.ts` | `src/project/revision-store.ts` |
| 2 | `src/project/schema.ts` (envelope, per-type row types, headers, `project.json`) + JSONL read/write; P1 green | `bindingKey`/`parseKey` (`id.ts`), step 1 | schema + io |
| 3 | tags + bookmarks + comments record types + their write verbs; A-PROV, A-DISPLAY (non-comment) | step 1/2 | three record modules |
| 4 | findings + status transitions + evidence resolution against `ArtifactService`; P2, A-STATUS | `ArtifactService` (spec 10), step 2 | finding module + resolver |
| 5 | `ProjectService` + `hbc2js project <verb>` CLI incl. bounds/truncation + `--help`; A-BOUNDS | `ArtifactService` warm index, CLI pattern | service + verbs |
| 6 | orphan detection on cross-`builtFor` load + `project orphans`; A-ORPHAN | step 2 io + `ArtifactService` target resolution (reviewer edit E4: the evidence resolver is step 4's; orphan detection needs only id-in-index lookup) | orphan pass |
| 7 | `project merge` + conflict records + `project conflicts`; A-CONFLICT | step 1 append-only | merge |
| 8 | `check-store.ts` + `measure.ts`; A-MEASURE; held-out run; landing report with the four numbers | spec 10 measure patterns | two scripts |

Steps 3–4 are independent and can run as parallel lean agents once 1–2 land.
Steps 6–7 depend only on 2. The overlay engine extraction (step 1) is the single
hard prerequisite and MUST keep every existing overlay test green.

## 8. Non-goals (v1) and where they attach later

- Disclosure/report generation → P2.7 (consumes confirmed findings).
- Cross-app-version id re-binding → P2.5 (consumes flagged orphans).
- Semgrep/OSV/taint auto-findings → P2.4 (writes THROUGH §3.2, not part of v1).
- Type/shape records → artifact `shapes.jsonl` (spec 10 §6), not this store.
- Live multi-user editing → batch merge only (§2.3).
- Any write-back into `.hbc` or any change to rendered code semantics (§4.3).

## 9. Open questions for the reviewer

1. **Names storage location.** WRAP keeps names in `<hbc>.names.json` /
   `overlay/names.jsonl` while other record types live under `project/`. Should
   v1 also *offer* (not force) relocating names into `project/names.jsonl` behind
   a flag for a tidy single-directory store, or is the split acceptable
   permanently? (Proposal: split is fine; do not add a second code path.)
2. **Comment range re-anchoring.** §1.2 re-anchors a moved site-comment to its fn
   and flags `range-stale`. Is fn-level fallback the right granularity, or should
   a moved comment attempt nearest-line re-anchoring via `ranges.jsonl` diff (more
   useful, more ways to be subtly wrong)? (Proposal: fn-level flag in v1;
   nearest-line is a P2.5-adjacent enhancement.)
3. **Mechanical tags in v1 scope.** `provably-dead` needs CFG reachability and
   `attacker-reachable` needs source-tagged call-graph traversal. Should v1 SHIP
   the mechanical proposers, or only reserve the tags and let humans/LLM assert
   them until Stage-3/P2.4 provides the analysis? (Proposal: reserve the tags in
   v1, ship the proposers in Stage-3/P2.4 where the analysis already lives — v1
   is the STORE, not the analyzer.)
4. **Merge without a shared base.** §2.3 line-union assumes both stores descend
   from the same artifact. Two stores built against DIFFERENT decompiles: refuse
   the merge, or merge-then-orphan-resolve? (Proposal: refuse unless
   `builtFor` matches; cross-version reconciliation is P2.5.)

## 10. Review responses

### Review responses (2026-09-03, Fable reviewer gate)

**VERDICT: APPROVED.** Implementation may launch at step 0 (§7). Every issue
found was resolvable by a small in-place reviewer edit (E1–E6, marked in the
text and enumerated below) plus the four §9 rulings. No CHANGES REQUIRED items
remain.

**Checklist findings**

1. *Decision-8 quadruples (§5)*: all four metric/target/method/held-out rows
   present and measurable, scripts named with exact invocations
   (`tools/project/check-store.ts --seed 1`, `tools/project/measure.ts`).
   Targets sane: integrity 100%-resolve on active records (orphan-rate
   reported, not targeted — correct, since orphan count is a property of the
   version bump, not the store); `for-fn` median ≤ 1.5 KB is consistent with
   its 40-line cap; store load ≤ 15% of `ArtifactService` index load and
   ≤ 300 B/record median are consistent with the §2.1 envelope (a tag record
   is ~200 B; findings pull the mean, not the median, up). Held-out =
   react-navigation (`fetch.sh`, never used while building the engine) plus a
   real rn-template version bump for the orphan policy with zero-silent-drop
   asserted. Edit E6: the landing report must state whether the bump used a
   re-fetched newer rn-template or a mutated-bytes artifact.
2. *§9 rulings*: below.
3. *P2.1-as-landed consistency* (spec written concurrently with the close-out
   — verified against the tree, not the spec): `src/name-overlay/{store,id,
   service}.ts` all exist; `bindingKey` is real; the shipped `name` CLI has
   exactly the §1.1 verb set (set/get/revert/search/list/context,
   `src/cli.ts`) with default store `<hbc>.names.json`; `ArtifactService`
   (`src/artifact/service.ts`) is landed with the warm-index pattern and the
   overlayHash staleness check now wired (null-tolerant per the BUGS row) —
   the §3 "follows `ArtifactService`/`NameService`" reference holds; spec 10
   §1 line 77 does reserve `overlay/names.jsonl` as claimed in §2.2. The
   renegotiated 70% index-size budget (spec 10 §5/§10) is not referenced by
   this spec — its own target 3 is store-relative and independent — so no
   stale number to fix. One found-and-fixed staleness interaction: comments
   in the canonical render (E2, below).
4. *Truth rules*: evidence resolution is enforced at write (§4.1 resolve-
   before-accept via the shared `ArtifactService`) AND at read (§3.3 live
   re-check; invalid findings excluded from active output but visible via
   `finding show` + `stat` invalid totals — not vanished). Provenance
   mandatory on all types incl. tool-proposed tags (§4.2). Orphan
   flag-never-drop path is complete: load-time detection, exclusion from
   active queries, `project orphans` + `stat`, merge keeps both sides +
   conflict record, revert is append-only — no route silently drops a
   record. Two gaps fixed: **E1** — §2.5 said orphans were "marked
   `status:"orphaned"`", contradicting §3.3 (orphan status is live-computed,
   never cached) and append-only; and the "captured last-known context" had
   no defined capture point. Now: `ctx` snapshot captured at WRITE time in
   the §2.1 envelope; orphan status computed live; stored lines never
   mutated. **E2** — §4.3 had comments rendering into code, which would
   shift `ranges.jsonl` line numbers on every `comment add`, outside spec 10
   §4.2's staleness model (manifest has overlayHash but no project-store
   hash) and would even stale other site-comments' anchors. Now: canonical
   render is a function of binary + names overlay only, byte-identical under
   ALL project-store writes; comments render only in an opt-in
   `render --with-comments` derived view. A-DISPLAY strengthened to match
   (E2b). Display-layer-only guarantee is otherwise explicit and
   by-construction (§4.3).
5. *Wrap-not-migrate (§2.4)*: sound. Verified `NameRecord` already carries
   `rid`/`supersedes`/`active` (`src/name-overlay/store.ts`), so
   `RevisionStore<T>` is a genuine extraction, not a redesign; the
   byte-identical contract on the shipped CLI + `<hbc>.names.json` is stated
   in §2.4 and guarded by A-WRAP (existing `tests/name-overlay/*` stay
   green, test-count floor per project CLAUDE.md). No migration step exists
   to get wrong.
6. *Implementation plan (§7)*: steps 0–8 are lean-agent-sized (one
   construct/file family + its tests each), ordering correct, reuse column
   pins each step to existing code, 3∥4 and 6∥7 parallelism is real. Fixed
   **E4**: step 6's reuse cell cited "step 2 resolver" but the evidence
   resolver is delivered in step 4; orphan detection needs only step-2 io +
   `ArtifactService` id lookup, so the stated "steps 6–7 depend only on 2"
   dependency claim now actually holds. Fixed **E5**: §6 said P1–P3 "ship
   with the spec", but the spec commit (a237fe8) is docs-only and
   `tests/project/` does not exist — §7 step 0 owns them; §6 now says so.
   The tests-before-implementation rule is satisfied because step 0 is a
   tests-only red harness preceding all code.

**Rulings on §9 open questions**

1. **Names location: split stands, permanently; no relocation flag.**
   Author's proposal accepted. The WRAP ruling (§2.4) exists to protect a
   shipped contract; an optional relocation is a second code path and a
   second on-disk location for the same data, with zero truth or efficiency
   gain. The tidy end-state arrives on its own: spec 10 already reserves
   `overlay/names.jsonl` inside the artifact directory for artifact-based
   work, so the legacy sidecar is transitional in practice without any
   migration code.
2. **Comment re-anchoring: fn-level fallback + `range-stale` flag in v1.**
   Author's proposal accepted. Nearest-line re-anchoring is a guess rendered
   as truth — a subtly wrong anchor on a security note is strictly worse
   than an honest `range-stale` flag (Stage-2 truth ordering). Line-level
   re-attachment belongs with P2.5's diff machinery, which will have the
   evidence to do it honestly.
3. **Mechanical tag proposers: v1 reserves the tags, does not ship the
   proposers.** Author's proposal sanity-checked and accepted. The analyses
   (`provably-dead` = CFG reachability, `attacker-reachable` = source-tagged
   call-graph traversal) live in Stage-3/P2.4; shipping proposers now would
   bolt unvetted analysis onto the store and grow v1 beyond
   lean-agent-sized steps. The taxonomy + `source:"tool"` provenance path
   (§4.2) is fully specified now, so proposers plug in later with no schema
   change.
4. **Merge across different decompiles: REFUSE unless `builtFor` matches.**
   Author's proposal accepted, with a stronger reason than tidiness, now
   recorded in §2.3 (E3): across different bytes the same `fn:N` can
   resolve to a *different* function, so merge-then-orphan-resolve would not
   merely orphan records — it would silently re-attach annotations to the
   wrong code, which no orphan check can detect. That is the exact truth
   failure the store exists to prevent. Cross-version reconciliation is
   P2.5's.

**Edits applied (all in place, marked "reviewer edit E*n*")**

- **E1** (§2.1, §2.5): `ctx` last-known-context snapshot captured at write
  time; orphan status live-computed, store never mutated.
- **E2** (§4.3, §6 A-DISPLAY): comments out of the canonical render; opt-in
  `--with-comments` view; canonical render byte-identical under all
  project-store writes.
- **E3** (§2.3): merge precondition `builtFor` match + wrong-resolve
  rationale (ruling 4).
- **E4** (§7 step 6): reuse cell corrected — step-2 io + `ArtifactService`
  lookup, not the step-4 evidence resolver.
- **E5** (§6): P1–P3 land as impl step 0 (tests-only), not with the
  docs-only spec commit.
- **E6** (§5 target 4): landing report states which version-bump artifact
  was used.
