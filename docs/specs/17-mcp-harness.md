# 17 — The MCP analysis surface: resources, tools, workflows (P2.7)

**Status: SPEC (2026-09-03, Fable). Design only — nothing here is implemented
yet. BUSINESS LOGIC ONLY.** This spec defines *what* the MCP server exposes to
an analysis assistant — the resources it can read, the verbs it can call, and
the loop it runs — over one project's `.hbcproj` database (spec 16) and the
shared fingerprint database (spec 15). It deliberately does **not** design the
transport, runtime, process model, or deployment of that server: those are the
owner's in-person decision and are fenced off in §6 ("Deferred to owner"). What
follows is the surface's *contract*, independent of how the surface is wired up.

Promotes `docs/specs/llm-harness-IDEAS.md` (Fred, 2026-09-03) from IDEAS to a
scoped spec for the interface layer only. The loop it sketches (lead → scoped
context → hypothesis → adversarial verify → fidelity check → record) is
reproduced here as the workflow (§3); this spec's addition is to pin every
resource and tool to an existing spec-10/11/16 query verb and its existing
token-cost cap, so the MCP surface is a *typed re-projection* of the shipped
query layer, not a new store or a new set of answers.

Reading list: `docs/specs/16-project-db.md` §3 (the query surface + caps this
spec re-exposes; the `log` history that makes a session auditable), §2.2 (`log`
row shape), §5 (the independent checker); `docs/specs/10-artifact-format.md`
§3.1 (query verbs + their hard bounds — cited, never restated), §4 (truth);
`docs/specs/11-project-store.md` §3.1 (annotation verbs + bounds), §4 (evidence
must resolve; provenance mandatory; the `open→confirmed` dynamic-evidence
guard); `docs/specs/15-sigdb-schema.md` §0–§1 (the shared fingerprint DB this
surface reads for package identification); `docs/specs/13-reuse-validation.md`
(the two-key package-id gate whose results §1.5 exposes); `src/name-overlay/
id.ts` (`bindingKey`/`parseKey` — the only id vocabulary, unchanged).

What this spec does NOT introduce: any new answer, any new cap, any new store.
Every resource resolves to a spec-10/11/16 read; every tool that writes goes
through `ProjectService`'s logged write path (spec 16 §1.2, §2.2); every cap is
the one already published for the underlying verb. This is an *interface*, so it
adds a shape (typed resources/tools) and a workflow, nothing to the truth base.

## 0. Where this sits in the pipeline

```
.hbcproj (spec 16)  ┐                         ┌─ RESOURCES (read, §1) ─► scoped context
  ix_* index        ├─ ArtifactService ──────►│    keyed to fnIndex / binding-id / sid
  revisions/log     │  ProjectService  (warm) │    each capped at its spec-10/11/16 bound
sigdb (spec 15) ────┘                         └─ TOOLS (verbs, §2) ────► navigate / query /
  fingerprint DB       (read-only, shared)          name / comment / tag / record finding /
                                                     request fidelity check
                                                        │ writes land via the logged path
                                                        ▼
                                            log row per write (spec 16 §2.2) = audit trail
```

The MCP surface sits exactly where the CLI verbs sit today (spec 16 §3.2): on
top of the two warm services, reading the one project DB plus the shared
fingerprint DB. The assistant is an MCP *client* driving this surface; the
server is one writer over one `.hbcproj` (SQLite's single-writer model, spec 16
§1.2). Stage-2 order holds, as always: (1) TRUTH first — every answer traces to
one of the two databases, a finding is a candidate until its evidence resolves,
and the independent checker (spec 16 §5) still gates any claim of decompilation
fidelity; then (2) EFFICIENT TO USE — every resource and tool carries the
existing per-verb output cap so the assistant spends its context on findings,
not on re-derivation.

## 1. Resources (read-side surface)

A **resource** is a read the assistant addresses by a stable key and gets back
an already-bounded answer. Every resource below is a thin typed wrapper over a
named spec-10/11/16 verb; its cap is **that verb's published cap** — cited here,
never restated (changing a cap is a spec-10/11/16 renegotiation with its own
measurement, spec 16 §6 target-2 ruling, not something this interface may do).
Keys are `fnIndex`, binding-ids (`bindingKey`, `src/name-overlay/id.ts`), string
ids (`sid:`), and module ids (`mod:`) — the same keys the databases use, so a
resource key survives every rename and re-render (spec 10 §0).

| resource | key | resolves to (verb) | cap |
|---|---|---|---|
| `fn/{fn}` — function summary | `fnIndex` | `query fn` (spec 10 §3.1) | that verb's ≤ 10 lines |
| `source/{fn}` — rendered source | `fnIndex` | `query source` (spec 10 §3.1) | fn's own range (the ONLY source-emitting resource) |
| `context/{fn}` — the scoped analysis slice: summary + callers + callees + strings-used + nearest crypto/storage calls | `fnIndex` | composition of `query fn` + `who-calls` + `calls-from` + `string` (spec 10 §3.1); no new answer | union of the component caps; truncation marked per component |
| `xref/who-calls/{fn}` | `fnIndex` | `query who-calls` (spec 10 §3.1) | that verb's ≤ 50 + total |
| `xref/calls-from/{fn}` | `fnIndex` | `query calls-from` (spec 10 §3.1) | that verb's ≤ 50 + total |
| `xref/string/{sid}` + `xref/string-grep/{regex}` | `sid` / regex | `query string` / `query string-grep` (spec 10 §3.1) | those verbs' caps (≤ 30 / ≤ 50 + total) |
| `xref/global-uses/{name}` | global name | `query global-uses` (spec 10 §3.1) | that verb's ≤ 50 + total |
| `xref/who-calls-by-name?fn=N\|name=X` | `fnIndex` OR export name | `query who-calls-by-name` (spec 10 §3.1; §14.1 below) | ≤ 50 candidate rows + total; `names[]` + `ambiguous` |
| `object-tables?minProps&stringRatio&key&value&minMatched&module&limit` | filter opts | `query object-tables` (spec 10 §3.1; §14.2 below) | ≤ 100 tables + total; rows inlined with `fnName`/`size` |
| `template-injections?module&limit` | filter opts | `query template-injections` (spec 10 §3.1; §14.3 below) | ≤ 100 rows + total; rows inlined with `fnName`/`size` |
| `native[/{fn}]` — native surface | optional `fnIndex` | `query native` (spec 10 §3.1) | that verb's ≤ 50 + total |
| `native/modules` + `native/module/{x}` + `native/seams[?status&firstParty]` + `native/manifest` — the APK-ingested tables (spec 27 §L1-L4) | `jsName`/module key, or filter opts | `query native modules\|module\|seams\|manifest` (spec 10 §3.1, spec 27 §L5) | those verbs' caps (modules/seams ≤ 100 + total; module/manifest one block); a seam is a first-class read object citing both a JS call site and a native module/method |

`native/module/{x}` is the same "kill the N+1" join `context/{fn}` already
does for calls: one call returns the module, its exported methods, AND every
seam that names it — an agent asking "what is the native impl of this JS
call" never needs a second round trip. `native/seams` is empty (never an
error) when a project has no native side ingested; `firstParty:null` on a row
means unresolved, not "no" — spec 27 §L4's own null-is-a-fact rule.
| `module/{mod}` + `module-graph` | `mod` | `query module` (spec 10 §3.1) | that verb's ≤ 15 lines |
| `package-id/{mod}` — fingerprint-DB identification result for a module | `mod` | reuse-validation two-key gate (spec 13) over the shared sigdb (spec 15) | spec-13 published cap; every row cites the sigdb match, never a guess |
| `annotations/for-fn/{fn}` — all names/tags/comments/findings asserted about a fn | `fnIndex` | `project for-fn` (spec 11 §3.1) | that verb's ≤ 40 + total |
| `findings[?tag&severity&status]` | query | `project findings` (spec 11 §3.1) | that verb's ≤ 50 + total |
| `finding/{id}` — full record + per-ref evidence-resolution status | finding id | `project finding show` (spec 11 §3.1) | that verb's ≤ 20 lines |
| `names/{fn}` + `name-context/{fn}/{reg}` | `fnIndex` / reg | `name list` / `name context` (spec 10 §3.1) | those verbs' caps |
| `log[?since&who]` — the session/project change history | query | `project log` (spec 16 §3.2) | that verb's ≤ 50 + total |
| `history/{target}` — full slot timeline for a target | binding-id | `project history` (spec 16 §3.2) | that verb's ≤ 40 + total |
| `annotated-calls[?tag&status]` — the cross-store join | query | `query annotated-calls` (spec 16 §3.2) | that verb's ≤ 50 + total |

Two databases, two provenances: `fn/`, `source/`, `context/`, `xref/*`,
`native`, `module*` come from the project DB's derived index stratum (spec 16
§2.4); `annotations/*`, `findings`, `finding/`, `names/*`, `log`, `history`,
`annotated-calls` come from its annotation stratum (spec 16 §2.3); `package-id`
is the ONLY resource that reads the *shared* fingerprint DB (spec 15) — and it
returns identification results, never fingerprints, each row tied to the sigdb
match that produced it.

`context/{fn}` is the token-saver named in the IDEAS draft §1a: it returns the
readable function plus its immediate neighbourhood and the strings/security
calls it touches, NEVER the whole bundle. It is a *composition* of shipped
verbs, so it introduces no answer the query layer cannot already give and no cap
the query layer has not already published — the interface's job is to bundle the
four reads into one round-trip, not to invent a fifth.

## 2. Tools (verbs the assistant calls)

A **tool** is a verb with typed inputs, a defined effect, and a bounded typed
output. Read tools are the resources of §1 addressed imperatively (same caps).
The **write** tools below all land through `ProjectService`'s logged write path
(spec 16 §1.2): each write is exactly one append to the annotation stratum plus
exactly one `log` row (spec 16 §2.2 — `seq`, timestamp, actor=`prov`, op,
affected `rid`). There is no write to the DB that is not a tool call, and no
tool call that writes without a `log` row (spec 16 A3). The derived index and
the fingerprint DB are **read-only** to every tool — the index is rebuilt
wholesale by the builder (spec 16 §2), never by this surface.

| tool | inputs | effect on the project DB | output + cap |
|---|---|---|---|
| `navigate` | a resource key (§1) | none (read) | that resource's answer + its cap |
| `query` | verb name + args | none (read) | the verb's answer + its cap |
| `set_name` | binding-id, name, `prov` | `ProjectService.setName` (overlay append; Design-D); resolves the id against the index BEFORE accepting (spec 11 §3.2) | 1-line confirmation |
| `add_comment` | target (fn/reg/env), body, optional range, `prov` | `ProjectService.addComment` (spec 11 §3.1); ref-resolved on write | 1 line |
| `add_tag` | binding-id, tag (`source`/`sink`/`reviewed`/`suspicious`/…), optional note, `prov` | `ProjectService.setTag` (spec 11 §3.1); mechanically-proposed tags stamped `source:"tool"` (spec 11 §4.2) | 1 line |
| `record_finding` | class, location `{fn,reg}`, claim, ≥1 evidence `ref`, `prov` | `ProjectService.addFinding` — REJECTED at write time if zero evidence refs resolve (spec 11 §4.1); a finding is a *candidate* (`open`) until its evidence resolves; **no self-confirm** (see below) | `finding#N open …` + cap ≤ 1 line |
| `set_finding_status` | finding id, status, evidence `ref…`, `prov` | `ProjectService.setFindingStatus`; `open→confirmed` requires ≥1 *dynamic-role* evidence ref (`trace`/`fuzz`/`repro`) — a static-only claim cannot self-promote (spec 11 §4.1) | 1 line |
| `request_fidelity_check` | candidate `{fn}` and/or a candidate decompile | queues the independent check (spec 16 §5 checker / disasm-diff / trace oracle); writes NO finding itself — it produces the evidence a later `set_finding_status` consumes | a `check#N` handle + verdict when ready; result is `trace:`/`repro:` evidence, cap ≤ 20 lines |

**The evidence rule (spec 11 §4.1), surfaced as an interface invariant.**
`record_finding` cannot fabricate: the write path resolves every `ref` against
the shared `ArtifactService` (binding-id → index, `sid:` → string table,
`mod:` → module graph) and the trace/fuzz artifact store, and REJECTS a finding
with no resolving ref. An assistant may not confirm its own claim: promotion to
`confirmed` needs a *dynamic* evidence ref, which comes from
`request_fidelity_check` or an external repro — never from another static read
the same assistant just made. This is the interface expression of "a bug is
never an artifact": the surface has no verb that turns a static hypothesis into
a confirmed finding without independent, dynamic evidence.

**`request_fidelity_check` is deliberately not a finding-writer.** It requests
the independent checker (spec 16 §5 — the DB is never both producer and
validator) and returns *evidence*, decoupling "assistant claims a decompile is
faithful" from "the checker agrees". The claim of decompilation fidelity is
gated by the checker, not by the assistant's confidence (§4).

## 3. Workflows (the loop the assistant runs)

The loop is the IDEAS-draft §2 core loop, re-expressed as MCP tool calls. It is
the token-cheap version of "read a function, form a hypothesis, record it":

1. **Pick a target.** From `findings?status=open` (resume prior work),
   `annotated-calls?status=open` (callers into open findings), `native`
   (native surface), or a directed goal → `xref/string-grep` +
   `xref/global-uses` for the security-decision call sites. Leads come from
   real signals in the two databases, never from reading every function.
2. **Read its context cheaply.** ONE `navigate context/{fn}` — the scoped slice
   (§1), not the bundle. Follow with targeted `xref/*` only as the hypothesis
   demands. Each read is capped, so a step's input cost is bounded by
   construction.
3. **Form a hypothesis, enrich as you go.** As understanding accrues,
   `set_name` / `add_comment` / `add_tag` write it back — analysis and naming
   are one act (IDEAS §2.4), so the next pass over the same code is cheaper and
   the state is shared across agents talking to the same server.
4. **Record it as a candidate finding with evidence.** `record_finding` with
   ≥1 resolving `ref` (code citation / `sid:` / xref path). It lands `open` — a
   *candidate*, not a claim. No evidence, no finding.
5. **Resolve or refute.** `request_fidelity_check` on survivors; a separate
   adversarial pass (fresh context, ideally a different model) tries to REFUTE.
   Only a candidate with dynamic resolving evidence reaches `confirmed` via
   `set_finding_status`; the rest stay `open` or are closed as
   informational/duplicate.
6. **Move on.** The next target's context is cheaper because step 3 left names
   and tags behind.

**Auditability comes from the DB's logged history, for free.** Every write in
steps 3–5 is one `log` row (spec 16 §2.2): `#seq ts actor op target`. So
`navigate log?who={run}` replays exactly what a session did, in order, with
provenance (spec 11 §4.2 makes `prov` mandatory — `human`/`llm`+run-id/
`tool`+invocation-id). `history/{target}` gives the full slot timeline of any
one target across sessions (supersessions, reverts, who/when). The session is
auditable because the *store* is auditable; the interface adds no separate log
and can rewrite no history — the append-only triggers (spec 16 §2.5) make even a
buggy client unable to alter the record.

## 4. Truth

The surface inherits the truth base of specs 10/11/16 and adds no way around it:

- **Every answer traces to a database.** Read resources resolve to the project
  DB (index or annotation stratum) or the shared fingerprint DB; there is no
  resource that computes an answer outside those two. `package-id` rows cite
  the sigdb match; `?`-marked index rows carry their `why` (spec 10 §3.1) — an
  unknown is surfaced as unknown, never guessed.
- **Nothing is fabricated.** A write tool that cannot resolve its refs is
  rejected at the write path (§2; spec 11 §4.1). Free-text findings are not
  writable.
- **A finding is a candidate until its evidence resolves.** `open` means
  candidate; a stale-target finding is returned `valid:false` and excluded from
  active output (spec 11 §4.1). The interface has no verb to skip this.
- **The independent checker still gates fidelity.** A claim that a decompile is
  faithful is settled by `request_fidelity_check` → the spec-16 §5 checker (the
  DB is never both producer and validator), not by the assistant. `confirmed`
  requires dynamic evidence (spec 11 §4.1). No tool self-confirms.

## 5. Decision-8 quadruple (metric / target / method / held-out)

The metric is interface efficiency and interface fidelity — measured as
token/step cost and as "the surface never returns an unsourced or over-cap
answer". Baselines are the shipped spec-10/11/16 CLI verbs on the same corpus.

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Truth**: (a) unsourced answers — resource rows with no resolving DB/sigdb source; (b) over-cap answers — any resource/tool answer exceeding the underlying verb's published cap; (c) self-confirmed findings — a finding reaching `confirmed` without a dynamic evidence ref | **0 / 0 / 0** (all three are interface-contract violations) | a driver replays every §1 resource × 20 sampled keys and every §2 write tool against a seeded `.hbcproj` + the in-repo sigdb slice; asserts each answer's rows resolve and each answer is within cap; asserts the write path rejects a self-confirm |
| 2 | **Tokens per analysis step**: median bytes/tokens the surface returns for one workflow step (`navigate context/{fn}` + one `xref` + one write) vs the same step composed from raw CLI verbs (parse text, re-issue) | ≤ 1.0× the CLI-composed step's bytes (no regression — the surface bundles reads, it does not enlarge them); report the round-trip count reduction (target: `context/{fn}` replaces ≥ 3 CLI calls with 1) | a `measure.ts`-style driver runs both paths on the same artifact, best-of-3, per-step median/max bytes + round-trip count |
| 3 | **Fixed task within a context budget**: a scripted analysis task ("name the crypto surface of module M and record one evidenced candidate finding") completed on a **sample bundle from `tests/fixtures`** within a fixed context budget | task completes within a stated token budget on `tests/fixtures/bundles/rn-template-0.72`, producing ≥ 1 `open` finding with resolving evidence and 0 over-cap reads; budget number reported | the driver runs the scripted tool sequence and asserts completion + the finding resolves + no cap breach; token count in the landing report |
| 4 | **Held-out check**: targets 1–3 re-run unchanged on a project never used while designing the surface | targets 1–3 hold on the held-out project | held-out = `tests/fixtures/bundles/react-navigation-example-0.85.3` (the spec-16 held-out bundle, not used here); spot-check `expensify-app-0.86.0` for large-bundle sanity, numbers in the report |

### 5.1 Acceptance tests

- **A1 (interface-contract, runnable pre-impl against a seeded `.hbcproj` +
  in-repo sigdb slice): every resource resolves and respects its cap.** For
  each §1 resource, the answer's rows resolve to a DB/sigdb source and the
  answer is within the underlying verb's cap; `context/{fn}` returns ≤ the union
  of its component caps and marks per-component truncation.
- **A2: no fabricated write.** `record_finding` with zero resolving refs is
  REJECTED; a finding with ≥1 resolving ref lands `open`.
- **A3: no self-confirm.** `set_finding_status … confirmed` with only static
  evidence is REJECTED; with a dynamic (`trace`/`fuzz`/`repro`) ref it is
  accepted (mirrors spec 11 §4.1).
- **A4: every write is logged.** After each write tool, exactly one new `log`
  row exists with the correct actor/op/target (spec 16 §2.2); `navigate
  log?who=X` replays the session in `seq` order.
- **A5: read-only boundaries.** No tool writes the derived index stratum or the
  fingerprint DB; an attempt is refused.
- **A6: fidelity is checker-gated.** `request_fidelity_check` returns checker
  evidence and writes no finding; a fidelity claim is only recordable as
  evidence a subsequent `set_finding_status` consumes.

### 5.2 Non-goals (v1)

- **Transport / runtime / deployment**: see §6 — deferred to the owner, not a
  v1 non-goal so much as out of this spec's remit entirely.
- **New answers or new caps**: this surface re-projects shipped verbs; a new
  query or a changed cap is a spec-10/11/16 change with its own measurement
  (spec 16 §6 target-2 ruling), never an interface-side addition.
- **Multi-writer / cross-project federation**: one server writes one `.hbcproj`
  (spec 16 §1.2 single-writer). Two projects = two surfaces; merge stays spec
  16 §4.2 (export → JSONL merge → `init --from`).
- **Weaponisation / exploit generation**: the surface is static characterisation
  only (IDEAS §2–§4); it records and evidences findings, it does not produce
  working exploits. Authorization to analyse a given bundle is the operator's
  (IDEAS §3), asserted outside this surface.
- **Agent topology / prompts / stopping rules**: the *client's* concern; this
  spec defines the tools an agent calls, not how many agents call them or with
  what prompt (IDEAS §6 open questions stay open at the client layer).
- **Write batching / transactions across tools**: each write tool is one logged
  append; a multi-write transaction verb is a later renegotiation.

## 6. Deferred to owner (transport / runtime / deployment boundary)

**This spec designs the business logic only. The fundamental transport,
runtime, process, and deployment architecture of the MCP server is explicitly
deferred to the project owner, to be decided in person.** This spec makes no
commitment on, and its acceptance does not settle, any of:

- **Transport / protocol binding**: stdio vs HTTP/SSE vs socket; MCP protocol
  version; framing, streaming, and back-pressure of large (near-cap) answers.
- **Process & lifecycle model**: one resident server vs per-invocation; who
  calls `open_bundle` and when the warm services start/stop; checkpoint/close
  discipline for the `.hbcproj` (`-wal` hand-off rule, spec 16 §1.1) as it
  interacts with a long-lived server.
- **Concurrency & the single writer**: how multiple client agents (review +
  verify) sharing one warm server serialise their writes onto SQLite's single
  writer (spec 16 §1.2); locking, queueing, or session ownership.
- **AuthN/AuthZ & scope enforcement**: who may connect, how the operator's
  authorization (IDEAS §3) is asserted and enforced at the boundary, and where
  VDP/scope config lives.
- **Deployment & isolation**: local-only vs networked; sandboxing; whether the
  shared fingerprint DB (spec 15, ~28 GB on `deb`) is co-located, mounted, or
  proxied.
- **Server framework / language / packaging**: which MCP SDK, how it embeds the
  two Node services, and how it ships.

The resources (§1), tools (§2), workflow (§3), and truth guarantees (§4) are
written to be **independent of every choice above** — they are the same verbs
and caps whether the server is stdio-local or networked-resident. That
independence is the point of specifying business logic first: the owner can pick
the architecture without reopening the surface's contract.

## 7. Open questions for the reviewer

1. **`context/{fn}` cap composition.** §1 sets its cap as the *union* of its
   component verbs' caps with per-component truncation marks. Is a union cap the
   right contract, or should `context/{fn}` carry its own single published cap
   (a spec-10 renegotiation) so the assistant sees one number? The union keeps
   this spec from inventing a cap; a single cap is friendlier to the client.
2. **`request_fidelity_check` async shape.** Modelled as request → handle →
   verdict-as-evidence (§2). Is returning a `check#N` handle the right business
   shape given the transport is deferred, or should the spec stay silent on
   sync/async and only pin "it returns evidence, writes no finding"?
3. **`package-id` as the only shared-DB resource.** Is reading the fingerprint
   DB (spec 15) exclusively through package identification (spec 13's two-key
   gate) the right boundary, or should the surface expose a raw fingerprint
   lookup? Raw lookup risks unsourced answers (§4); the gate keeps every row
   cited.
4. **Directed-goal leads (§3 step 1).** Left as "client composes `string-grep` +
   `global-uses`". Should the surface offer a `trust_boundaries` resource
   (IDEAS `list_trust_boundaries`) as a first-class read, or is that a client
   composition to keep the surface minimal?
5. **Tool granularity vs the CLI verbs.** Every tool is 1:1 with a shipped verb
   except `context` and `request_fidelity_check`. Is that the right minimal set,
   or does the loop want a coarser `analyse_target` verb that bundles steps 2–4
   (fewer round-trips vs less client control)?

## 8. Review responses

_(placeholder — reviewer fills in on the decision-8 gate, as in spec 16 §11.)_

Co-Authored-By: Claude Fable <noreply@anthropic.com>

## 12. Surface edits (Fred, 2026-09-04)

Reviewed the resource + tool surface. Kept as drafted, with two changes:
- **`add_comment` confirmed first-class** among the write tools (annotation, logged path, provenance required) — no change, noted explicitly.
- **NEW read resource `disasm/{fn}`** — exposes the raw Hermes bytecode / disassembly of a function (the `src/disasm` output), distinct from `source/{fn}` (the lifted, decompiled source). Same fnIndex/binding-id keying; token-cap = one function's instruction listing (bounded like `source/{fn}`; a very large function clips with a continuation marker). Rationale: an analyst verifying a subtle lift, or working where recovery is incomplete, needs the ground-truth instructions, not only the rendered source.

Fundamentals (transport, lifecycle, auth, deployment, framework) remain deferred to Fred. My earlier prune-flags (navigate/query redundancy, string vs string-grep, module vs module-graph) are left as reviewer notes, not acted on — Fred approved the surface as-is.

## 13. Recompile / patch-and-test tool (Fred, 2026-09-04)

**NEW write/action tool `recompile_edit`** (name provisional). Purpose: the research loop sometimes needs to test a hypothesis by editing a function's source and rebuilding it — patch-and-verify, the standard binary-analysis move (edit → recompile → run → compare), feeding the existing `request_fidelity_check` / trace-comparison loop.

- **Inputs:** a target ({fn}/module) + edited source; compiles it with the project's own `tools/hermesc/vNN` to Hermes bytecode and optionally splices it into a COPY of the bundle. Never mutates the original bundle or the `.hbcproj`.
- **Output:** a clearly-labelled synthetic/modified artifact (its provenance record marks it edited-and-recompiled, with the base bundle hash + the edit), and, if run, its trace for comparison. Never presented as, or confused with, the original.
- **WARNING (required, per Fred):** unlike every other tool this one PRODUCES A MODIFIED BINARY, not a read-only answer. It carries an explicit warning/confirmation before it runs, the output is watermarked as a modified artifact, and it is scoped to local hypothesis-testing inside the research loop — not distribution. It writes a `log` row like any other action so the session stays auditable.
- Fundamentals (sandboxing/isolation of the recompile+run step) fold into the transport/lifecycle design deferred to Fred.

## 14. Surface revision (Fred + review agent, 2026-09-04) — BINDING

Reviewed hands-on against an NSW hunt. Supersedes the §1/§2 surface where they conflict.

**Cuts:**
- **CUT `query`** — a generic unbounded reader is the opposite of the token goal (invites whole-bundle dumps). Its legitimate need is replaced by paginated `search/*` below.
- **CUT `navigate`** — implies cursor state; every read is already addressable by {fn}, so the state is pure complexity.
- **CUT full `module-graph`** — a 4,510-node dump on NSW, another unbounded footgun.

**Merges / reshapes:**
- **`context/{fn}` gains `include: [metadata, source, callers, callees, strings]` + a depth** — tunable, never double-fetches source. `fn/{fn}` and `source/{fn}` remain as minimal presets (fn = cheapest, flags only; source = source without the xref envelope).
- **Merge the two string endpoints into one `xref/string` with `mode: exact | substring | regex`.**
- **`module/{mod}`** returns the module + its DIRECT edges only; the analyst walks it (no whole-graph read).
- **`name-context` = pass-through to P2.1a** (wrap the overlay's existing defs/uses; do not reimplement).
- **Inline light metadata in every xref result**: each neighbor returns `{fn, name, size}`, not a bare id — kills the N+1 (who-calls forced ~12 follow-up fn/{fn} calls).

**Additions (from what the hunt actually needed):**
1. **`leads` / `security-sinks` (highest value)** — enumerate security-decision call sites grouped by class (verify/sign/decrypt/keychain/AsyncStorage/WebView/…). The entry point to the whole loop; today you must grep for it.
2. **`scan/{secrets|deps|semgrep}`** — the cheap lead generators, callable (not just the `package-id` read). The loop's lead-generation step.
3. **`search/functions` (by name) + `search/source` (bounded grep)** — paginated, typed; the safe version of the cut `query`. Finding "the licence-validity function" is a constant need.
4. **`generate_documentation` (Fred)** — emit a shareable, self-contained reproduction script/report from the session's logged tool history + findings, so a third party can REGENERATE the findings and run the POCs (uses the log + `recompile_edit`). The payoff of the auditable-log design: a session becomes a portable, re-runnable disclosure artifact.
5. **FLAG for the future: `trace` / `dataflow`** — the two questions that actually mattered on NSW ("does the render bind to a verified payload", "does the PIN reach local AES") are data-flow questions xref can't answer. Needs the taint engine we don't have yet; note it now as the eventual killer endpoint.

**Write side — one fix, rest unchanged:**
- **`set_finding_status → confirmed` accepts EITHER a dynamic repro OR a fidelity-checked STATIC proof.** Dynamic-only over-constrains: a hardcoded key, or a signature parsed-but-never-checked, is provable from the code alone. Broaden what counts as confirming evidence; keep the evidence gate.
- **Keep exactly as-is:** `record_finding` requires a resolving evidence ref; no self-confirm; every write logged + replayable. This bakes truth-first in as a schema constraint, not a prompt. Distinction that is the throughline: requiring evidence for a finding is legitimate rigor; refusing a capability is crippling — the write side is the good kind.

### 14.2 `object-tables` — bundle-wide constant-table inventory (2026-09-04, landed)

The second Round-2 tool-gap (`docs/specs/hunt-tooling-backlog.md`): the NSW
hunt found a SECOND complete endpoint table (`LicenceAPIEndpoints`) only by a
lucky grep, because nothing could answer "show me every constant table in this
bundle". This verb answers it in one pass, with no JS parsing and no
decompilation.

**How.** Every object literal whose members are compile-time constants is a
`NewObjectWithBuffer` / `…Long` / `NewObjectWithBufferAndParent` whose keys and
values live in the key/value buffers (v≤96 inline operands, v≥97 behind
`mod.shapes` — `src/emit/lower.ts`'s own two shapes). `src/artifact/object-tables.ts`
decodes every function ONCE (decode only: no CFG, no frames — measured 96 ms
for 15,551 functions on react-navigation-example-0.85.3, ~1.1 s for 43,384 on
Service NSW) and reports, per literal: `fn`, instruction `offset`, `module`,
`numProps`, the members (`key`, string `value` truncated at 200 chars, `kind`),
and the `strings`/`nonStrings` counts. A function that will not decode is
skipped and counted in `failed`, never fatal.

**Computed members (best-effort).** A member whose value is built at runtime
(`BASE + "/x"`, a template literal) is not in the buffer; hermesc emits it as
`PutNewOwnById`/`PutById` — or, at v≥98, `PutOwnBySlotIdx` (no string
operand at all: the key is the shape's own `keys[slot]`) — on the literal's
own register straight after. A tail key that already exists in the buffer
REPLACES that member (the buffer entry was a placeholder), so a computed
member is never listed twice. Those
KEYS are recovered by a straight-line walk forward that stops at the first
branch target, the first non-`normal` instruction, or the first redefinition of
the register — so a reported key is always really this literal's. The value is
reported as `kind: "computed"` (`<computed>` in text): proving it would need the
decompiler, and this verb deliberately never runs one.

**Shape.** `hbc2js query object-tables --artifact <dir> --hbc <in.hbc>
[--min-props N] [--string-ratio R] [--key <re>] [--value <re>] [--min-matched N]
[--module M] [--limit N] [--all] [--json]` / `ArtifactService.objectTables(opts)` /
`McpResources.objectTables` / `GET /api/object-tables?minProps=&stringRatio=&key=&value=&minMatched=&module=&limit=`.

**Filter / bounds.** Default: ≥ 4 members AND ≥ 50% of them string-valued —
the shape of a table, as opposed to an options bag. `--key`/`--value` are
ECMAScript regexes over member keys / string values; a table matches if ANY
member matches. Each row also reports `matched`, the number of members that
satisfied those patterns (the table's own member count when neither was
given), and `--min-matched N` (default 1) drops tables the query barely
touched. ≤ 100 tables by default plus
`total`/`truncated`, ≤ 20 member lines per table in text output. The scan
itself is memoised per `ArtifactService`, so repeated filtered queries are a
filter over an array, not a re-scan.

**Ranking (2026-09-04 follow-up).** An UNFILTERED query sorts by size — nothing
else is known about relevance. A FILTERED one sorts by `matched`, then by hit
DENSITY (`matched / members`), then by size (`compareObjectTables`, exported
and unit-tested). Reported on the live NSW ui-server: `?value=^/&minProps=4&limit=2`
used to return the 2,125-member HTML-entity table (module 2447) first, because
its `&sol;` member is `"/"` and the sort was purely by member count; the two
real endpoint tables (41 and 22 fully-matching members) now lead.

**Measured (Service NSW, 43,384 functions).** `--value '^(/|https?:)' --min-props 4`
→ 645 tables; `--value '^/'` → 162, ranked (see above) so that BOTH endpoint
tables lead: fn 10635 (module 778, 38 members, 35 matching — `PATH_AUTHENTICATE`/
`PATH_BEARER_TOKEN`/…) then fn 11367 (module 818, 20 members, 12 matching —
`PATH_OLD_DRIVER_LICENCE`/`PATH_DDL_OPT_IN_STATUS`/… = the `LicenceAPIEndpoints`
table the hunt originally found by luck). Adding `--min-matched 4` narrows the
162 to exactly those two.

### 14.3 `template-injections` — WebView-injection anti-pattern scan (2026-09-04, landed)

Backlog item #9 (`docs/specs/hunt-tooling-backlog.md` line ~55), hunt lead
C1: a template literal or `+`-concatenation whose static text QUOTES a
runtime substitution, e.g. `` `window.foo('${userValue}')` `` or
`"x = '" + userValue + "'"`. That shape is exactly what turns "we pass a
value into `injectedJavaScript`" into "we pass a value into
`injectedJavaScript` in a position an attacker can break out of with a `'`
in the value" — a security-relevant lead a hunt today can only find by
grepping for `injectedJavaScript` and eyeballing every hit.

**How.** No decompilation, like `object-tables` (§14.2): `src/artifact/
template-injections.ts` decodes every function ONCE (decode only — no CFG,
no frames) and walks it straight-line, tracking a per-register "reaching
definition" map that is DROPPED at every branch target — so a reported
chunk is always really this call/chain's, never guessed across a CFG edge.
Two bytecode shapes are recognised, matching `docs/lowering/
template-literals.md`'s finding that hermesc never confuses `concat` (a
template literal — ToString per piece) with `+` (ToPrimitive):
`kind: "template"` is one call whose callee resolves through that map to a
`Get*ById "concat"` off a `Get*ById "HermesInternal"` base, `this` = the
first cooked chunk, args alternating `substitution, chunk, …` (both the
explicit-register `Call1`..`Call4` and the generic `Call`/`CallLong`, whose
args are recovered from the function header's `frameSize` alone via the
same `argBase - i` convention `src/emit/lower.ts`'s `frameArgs` uses — no
CFG needed); `kind: "concat"` is the OUTERMOST `Add`/`AddN`/`AddS` of a
chain, flattened by recursing through operands whose reaching def is
itself an `Add`. A chunk position that does not resolve to a string
literal (a nested template, a nonliteral built across a branch) drops the
whole call — never a guessed chunk.

**Truth rule — what is and is not recognised.** Recognised: a direct
`Call*`/`CallLong` to `HermesInternal.concat` (not a `Reflect.apply`
indirection — that is the EMITTER's rebuild of the raw call, and this
scanner reads raw bytecode) whose every chunk is a compile-time string
literal reachable in the SAME straight-line block as the call; the
outermost `Add`/`AddN`/`AddS` of a `+` chain with the same constraint.
NOT recognised: a callee/chunk reached through a register hop that crosses
a branch (the reaching-def map is dropped at every label — a definition
that depends on which edge was taken is not "this call's" with certainty);
`.concat(...)` on anything other than `HermesInternal` (plain
`Array.prototype.concat`/`String.prototype.concat` are extremely common and
are not templates); a quote pair whose two halves come from two different
calls/chains. A found quote pair is reported with `substitutions` = how
many of that call/chain's substitutions fall INSIDE it (the ranking key)
and `nSubs` = the total in the whole expression; `prefix`/`suffix` are the
static text either side of the quotes, capped at 120 chars (holes shown as
`${…}`).

**Shape.** `hbc2js query template-injections --artifact <dir> --hbc <in.hbc>
[--module M] [--limit N=100] [--all] [--json]` / `ArtifactService
.templateInjections(opts)` / `McpResources.templateInjections` /
`GET /api/template-injections?module=&limit=`. Ranked by
`substitutions` desc, then `fn` (`compareTemplateInjections`, exported and
unit-tested). No UI pane yet — `ui/src/contracts.ts` carries the additive
`TemplateInjectionRow`/`TemplateInjections` types for a future one.

**Measured (Service NSW, 43,384 functions, same corpus as §14.2).** One
CLI call (`--json`, cold `--hbc` decode included) completed in ≈ 1 s,
`scanned:43384 failed:0`, `total:245` rows. The top 5 by
substitutions-inside-quotes are all in bundled LIBRARY code, not app code —
`fn:36610` (module 3611), `fn:4253` (module 334), `fn:5794` (module 498),
`fn:7560` (module 551), `fn:7565` (module 551) — consistent with the shape
being common in error-message/JSX-string builders generally, not a signal
on its own; a hunt still has to read each hit's actual text (`query
source`) to judge whether the quoted hole is attacker-reachable.

### 14.1 `who-calls-by-name` — name-based caller recovery (2026-09-04, landed)

The DOMINANT tool-gap of the overnight hunt (`docs/specs/hunt-tooling-backlog.md`
"Round 2"): on the NSW bundle, and on any Metro/RN app that does
`const m = require(list[N])` once into an env slot then `m.export(...)`, plain
`who-calls`/`calls-from` return `total:0` — the callee register is
list-indexed, so the calls index records `?`. The backlog's cheaper-fix
refinement is landed here as a NAME-based verb; the full points-to pass is
reserved for the residue (see below).

**Shape.** `hbc2js query who-calls-by-name <fn:N | --name X>` /
`ArtifactService.whoCallsByName({fn}|{name})` /
`McpResources.whoCallsByName` / `GET /api/xref/who-calls-by-name?fn=N|name=X&all=`.

- **by fn (`fn:N`)** — step 1: prove, from the bytecode of N's lexical parent
  and its owning module's factory (a lazy ≤2-function decode; needs `--hbc`
  like the other live verbs), the property names N's closure is stored under
  (`CreateClosure`→`PutById`/`PutNewOwnById` def-use: `src/artifact/exported-names.ts`).
  Step 2: for each such name, every function that READS it as a property
  (`property-get` string-use), EXCLUDING N's own module. `excludedModule` is
  reported.
- **by name (`--name X`)** — step 2 alone, no exclusion.

**Caps / bounds.** ≤ 50 candidate rows + `total` + `truncated`; `--all`/`?all=`
lifts the cap. The result also carries `names[]` (each `{name, sid, ambiguous,
why?}`).

**Confidence semantics.** Every row carries `confidence: "by-name"` — a NAME
match on a `property-get`, NOT a resolved call edge. It says "some function
reads a property with this export's name"; it does not prove the receiver is
this module's export. Consumers must never treat a by-name row as a
`who-calls` edge.

**Ambiguity.** A name that is a common JS member (`default`, `get`, `map`,
`then`, `length`, … — the `AMBIGUOUS_NAMES` set) or that is read as a property
in more than `BY_NAME_FANOUT_LIMIT` (200) functions is returned with
`ambiguous: true` + a `why`, and contributes NO rows (say so, don't dump
noise).

**Known false-positive classes.** (1) An unrelated object with a same-named
method (`x.remove()` where `x` is a Map, not the exporting module) — the verb
cannot see the receiver's type. (2) A re-export/barrel that reads the name to
forward it. (3) Two distinct modules exporting the same name; the by-name scan
cannot tell which one a given `property-get` targets. These are the reason the
`confidence` marker exists and the reason common names are suppressed.

**Points-to residue.** What by-name does NOT resolve: the *actual* receiver
identity. Where the app calls `list[N].export(...)` but `N` is only known via
register/list-index dataflow, the by-name candidates are a superset (the true
caller plus the false-positive classes above). Resolving the receiver to a
specific module still needs the full require-`N` points-to pass the backlog
flags as the follow-up for the residue. Measured on rn-template: of 3,909
functions with `who-calls total:0`, **484** gain ≥1 by-name candidate.

### 14.4 `require(N)` points-to pass — resolving the RECEIVER (2026-09-05, landed)

§14.1's recorded residue, closed: `who-calls-by-name` returns a NAME-based
SUPERSET; this pass resolves the receiver's IDENTITY, so the call becomes a
real, module-scoped edge. Implementation `src/artifact/points-to.ts`, index
`index/calls-resolved.jsonl` (spec 10 §2.2a), merged into `who-calls` /
`calls-from` / `McpResources.whoCalls` / `GET /api/fn/{fn}/callers` with
`confidence: "points-to"`.

**The lattice.** Per register, straight-line, DROPPED at every branch target
(the reaching-definition idiom of `object-tables.ts` / `template-injections.ts`):

| value | proven by |
|---|---|
| module M | `require(dependencyMap[i])` inside a known factory with `i` a compile-time index (the same recognition `semantic-walk.ts` uses for the `m:<id>` call row), or a `LoadFromEnvironment` of a slot every writer of which proved module M |
| export E of M | a `Get*ById "E"` off a module value; plus the reserved key `module.exports` for the module VALUE itself (`module.exports = function …`, then `require(d[N])(…)`) |
| unknown | everything else — absent from the map |

**Environment identity** is taken from the module's already-built `EnvGraph`
(`resolvedAt` for the access site, `EnvSlot.accesses` for every store to a
slot bundle-wide), not from a hand-rolled `GetEnvironment`-level walk
(docs/DECISIONS.md D26). A slot resolves ONLY when every one of its store
accesses is a proven store of the SAME module.

**Sound refusal — a missing edge beats a wrong one.** Any unresolved link
drops the edge; one edge per call site, or none.
- A slot whose store list contains a store this pass did not prove: refused.
- A slot INDEX that any bundle-wide UNRESOLVED store writes (the env graph
  could not resolve that store's environment, so it could target any
  environment's slot of that index): refused module-wide.
- An export name is resolved to a function only when exactly ONE closure in
  that module's factory is stored under it on a PROVEN exports object (the
  factory's `exports` parameter, `module.exports` off its `module`
  parameter, or the object a `module.exports = …` installed). Two closures
  under one name, or one closure plus one unproven value under the same name
  (the LAST write wins at runtime, so the target is not provable), resolve to
  nothing.
- A factory whose parameter count cannot locate `exports`/`module`
  positionally is skipped entirely.

**False-positive classes it REMOVES** (§14.1's list): (1) a same-named method
on an unrelated object — the receiver is proven, so an unrelated object is
never an edge; (2) a barrel/re-export that merely reads the name — no call, no
edge; (3) two modules exporting the same name — the edge names WHICH module.
The construct fixture `tests/fixtures/constructs/62-require-slot-dispatch`
pins exactly that: two modules both export `run`, and the resolved edge is
module 0's.

**What still escapes (honest residue).** A receiver that is a parameter, a
property of another object, or a value that crosses a branch target; an
`_interopRequireDefault(require(d[N]))` wrapper (the module value is consumed
by a call, so it is dropped); babel's `exports.default = void 0;` prologue,
which makes `default` unprovable for every module that uses it; a
`module.exports` assembled by a helper. Measured tail: on rn-template 152 of
1,086 proven `export E of M` call sites had no provable target; on the Service
NSW bundle 5,183 of 11,972.

**Cost.** Decode-only and NOT bundle-wide: the pass decodes the module
factories plus the readers of a slot it proved (rn-template 452 of 4,199
functions, NSW 7,134 of 43,384), with a bounded fixed point (≤ 4 rounds).
Measured: rn-template 22 ms (10.6% of `writeArtifact`'s 208 ms), NSW 705 ms.

**Measured (rn-template).** 934 resolved edges over 208 distinct caller
functions; 8 callee functions that had `who-calls total:0` now have real
edges. For those same 8 callees, `who-calls-by-name` offers 4 candidate rows
in total — the class is structurally invisible to a by-name scan, because a
`module.exports = function …` module has no export NAME to match.
**Service NSW** (counts only): 4,510 modules / 43,384 functions → 6,789
resolved edges, 2,164 proven environment slots, 2,629 distinct callers, 86
functions lifted out of `who-calls total:0`.

## 15. Provenance tier + shared service context (2026-09-04) — landed

Two follow-ups this round closed: §14's own recorded gap ("`src/mcp/tools.ts` has no `tier`/`author` field ... belongs to the owner of `src/mcp/tools.ts`", also spec 23 §4) and spec 22 §3.5's read-after-write note.

**Provenance tier.** `SetNameInput`/`AddCommentInput`/`AddTagInput`/`RecordFindingInput` gain `tier?: "suggested" | "accepted"`, a SIBLING of `prov` (not a field a caller sets on `prov` itself) — the write method folds it into the `Provenance` that actually lands (`{...prov, tier: tier ?? "accepted"}`). Default `"accepted"`: every caller that predates this field, or simply omits it, writes exactly what it always did.

Storage: `Provenance` (`src/project/schema.ts`) and `DbProvenance` (`src/projdb/revision-store.ts`) both gained an optional `tier` field, carried the same way `source`/`who`/`run` already are. On the DB side this is NOT a column on `revisions` — this sqlite build has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (checked directly; syntax error), and `tests/workers/storage.test.ts`'s "migration block is idempotent" test replays a minor's migration SQL twice against a live DB, so an in-place column add couldn't be made idempotent the way `CREATE TABLE IF NOT EXISTS` already is. Instead: **MIGRATION 3** (`src/projdb/schema.sql`, `SCHEMA_MINOR = 3`) adds one new side table, `revision_tier (rid PRIMARY KEY REFERENCES revisions(rid), tier)`, one row per `rid` that named a tier explicitly; a `rid` with no row (every pre-this-round write, and every write that still omits `tier`) reads as `'accepted'` (`revision-store.ts`'s `readTier`, COALESCE at read time) — no backfill needed, an older DB migrates with zero rows in the new table and every existing name/comment/tag/finding unchanged. `DbRevisionStore.set()` writes one `revision_tier` row per fresh `revisions` row it mints (never on `revert`, whose bookkeeping row carries no detail of its own).

**The name slot is truth, a suggestion is not.** `set_name`'s slot key (`src/projdb/annotations.ts`'s `nameSlot`) used to be `name:<target>` unconditionally; it now depends on tier: `'accepted'` keeps that exact slot (so `dbGetName`/`dbRevertName`/every existing caller is unaffected), `'suggested'` gets its own slot per proposer, `name:<target>:suggested:<who>` (same discriminator trick `tagSlot`/`findingSlot` already use for their own extra key component). A suggested write can therefore never become that target's active/displayed accepted record, regardless of write order, and two different proposers' suggestions coexist (one proposer suggesting twice supersedes only their own prior suggestion). `dbListSuggestedNames(db, target)` enumerates every live suggestion for a target (`dbGetTags`'s own per-slot-then-`get()` pattern, copied). `ProjectService` exposes both as reads: `getName(target)` (accepted only, `null` for JSONL-backed) and `listSuggestedNames(target)` (`[]` for JSONL-backed).

`McpTools.promote({kind:"name", target, rid|name, prov})` re-records a suggested value as accepted, under the PROMOTER's own `prov` (never the original suggester's) — via the exact same `set_name` write path every other accepted name write uses (`ProjectService.setName` -> `dbSetName`, forced `tier:"accepted"`). `rid` resolves against `listSuggestedNames`' current rows (refuses — throws — if it names no live suggestion); `name` promotes an explicit value directly, bypassing any stored suggestion. Comments/tags/findings never need a `promote`: a `'suggested'` write on those kinds is additive already (spec 23 §4: "Comments are the right home for a suggestion ... they never displace a human's name"), so there is no truth slot for them to occupy.

`McpResources.fn()`/`context()`'s `metadata` never read the `.hbcproj` name slot at all before this round (only `ArtifactService.fn()`'s own `name`/`overlayName` — the compiled name and the separate Design-D name-overlay store). This round adds `acceptedName`/`suggestedNames` ADDITIVELY as their own fields (`AnnotatedFnSummary`), never replacing `name`/`overlayName` — reconciling "the one name a reader sees" across the compiled/overlay/annotation-DB name sources is a separate follow-up, out of scope here.

Tests: `tests/mcp/tier.test.ts` (suggested doesn't move the accepted slot/displayed name; a second suggestion from the same proposer supersedes only their own; promote by `rid` and by explicit `name`; promote refuses a dead `rid`; tier defaults to accepted on the other three write tools; an old pre-MIGRATION-3 DB migrates and opens read/write; MIGRATION 3's block is idempotent replayed twice). `tests/workers/storage.test.ts`'s own migration-marker test was pinned from `SCHEMA_MINOR` (now 3) to the literal `2` for its worker-table check, since that check is specifically about MIGRATION 2's tables, not "whichever migration is current" — a mechanical fix, no assertion inverted.

**Shared service context.** `McpResources` and `McpTools` used to each build their OWN `ArtifactService`/`ProjectService` pair (both classes' own prior doc comments: "this round does not share a live pair across the two classes ... deferred to the transport binding, §6") — a write through one `McpTools` was invisible to a DIFFERENT `McpResources`'s in-memory-cached reads (`ProjectService`'s `tagStore`/`commentStore`/etc, spec 16 §3.2's "warm services") until that `McpResources` was rebuilt from scratch. `src/ui-server/server.ts` carried exactly that workaround: rebuild `ctx.resources` after every successful `/api/tools/*` write.

`src/mcp/context.ts`'s `McpContext` is the shared-pair decision spec 17 §2's doc comment deferred: it builds ONE `ArtifactService`/`ProjectService` pair and hands out `.resources`/`.tools` constructed OVER those same instances, via a new optional third constructor parameter both `McpResources`/`McpTools` gained (`services?: {artifact, project}` — internal-only, every existing 2-arg call is unaffected). A write through `.tools` reloads the shared `ProjectService`'s own in-memory caches (`reloadFromDb()`, unchanged); since `.resources` reads through that SAME instance, the next read sees the write immediately, no rebuild anywhere. `src/ui-server/server.ts` now builds `ctx` from one `McpContext` and no longer rebuilds `ctx.resources` after a write (`UiServerCtx.resources` is `readonly` again); `WRITE_TOOL_PATHS` (`src/ui-server/routes.ts`) is kept as a still-useful "which tool routes are writes" classification even though nothing rebuilds off it anymore.

Tests: `tests/mcp/context.test.ts` (`.resources`/`.tools` share one instance; a `.tools` write is visible to `.resources`'s very next read with no rebuild; the existing 2-arg constructors still build separate instances). `tests/ui-server/routes.test.ts`'s write tests and the SSE test (`GET /api/events forwards a log event after a set-name write`) had their manual `refreshCtxResources()` replica of the old workaround deleted and still pass — the read-after-write property now holds structurally, not by a call a test has to remember to make.
