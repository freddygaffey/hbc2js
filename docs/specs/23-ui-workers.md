# 23 — Server-owned AI workers: jobs, presence, provenance (spec)

Status: **written 2026-09-04** (wave 1, track D), skeleton landed with it
(`src/workers/`, additive schema minor 2). Successor of spec 22 (§5 names this
file). Reading list: `docs/AGENT-BRIEF.md`, `docs/specs/18-project-storage-integrity.md`
(the storage rule this spec obeys), `docs/specs/17-mcp-harness.md` §2/§14 (the
write tools every participant uses), `docs/specs/21-live-update-and-worktrees.md`
(the log-as-change-feed pairing), `docs/specs/22-ui-mvp.md` (the surface this
hangs off).

## 0. The problem, and why the server owns the workers

The decompiler should be able to answer *"what does this function do"*, name
things, and work alongside the human like a second cursor in a shared document.
MCP has three server-initiated mechanisms — **sampling**, **elicitation**, and
**resource subscriptions/notifications** — and none of them is a reliable engine
for that:

- a **notification** does not give a connected model a turn: the client may
  ignore it, and nothing is guaranteed to run;
- **sampling** is optional and support varies by client (many popular clients
  never advertise it), so a design that depends on it works on one machine and
  not the next;
- **elicitation** asks the *human*, which is a different job (approval), not
  a way to get work done.

Therefore: **the server owns its workers.** A worker is a process the UI server
spawns and controls (a headless CLI agent, or an agent SDK call, or a plain HTTP
model call), with our own MCP surface attached to it. MCP-connected external
agents (Claude Desktop, an IDE, a CLI session someone opened themselves) are
**just another participant class** — they are not the engine, and nothing breaks
when none is connected.

Every participant — human in the UI, server-owned worker, external MCP client —
writes through the **same write tools** (`src/mcp/tools.ts`) and therefore
through the same revision store, the same shard export, and the same
hash-chained log (spec 18 §6). That is what makes provenance hold: there is one
write path, and it always records who wrote.

## 1. Job model

A **job** is one unit of AI work with a declared input, a declared output shape,
and a bounded cost. Jobs are queued in the project DB (§2 tables) and executed by
the runner.

| kind | input | output (as write-tool calls) |
|---|---|---|
| `explain-fn` | `{fn}` | `add_comment` on `fn:N` — a prose explanation |
| `suggest-name` | `{fn}` | proposal recorded on the job + `add_comment` on `fn:N`; the *name* is written by `set_name` only on acceptance (§4) |
| `name-module` | `{module}` | proposal + `add_comment` on `mod:N`; `set_name` on acceptance |
| `summarise-leads` | `{class?, limit?}` | `add_comment` on the project root target, one summary per lead class |
| `doc-screen` | `{fn \| module}` | `add_comment` describing the UI screen a component renders |
| `rerun-findings` | `{since?}` | `set_finding_status` proposals only; status changes are never auto-applied (spec 17 truth rule 2) |
| `poc-finding` | `{findingRid}` | a proposed repro script recorded on the job; `recompile_edit` is **never** run by a worker unattended (§7) |

**Common fields.** Every job carries:
- `id` — content hash of `(kind, canonical(input), idempotencyKey)`;
- `idempotency_key` — UNIQUE. Default `sha256(kind + canonical(input))`, so
  "explain fn 188" enqueued twice while the first is still queued/running is
  **one** job; a caller that wants a genuine re-run passes its own key (e.g.
  suffixed with the render hash or a nonce);
- `cost` — JSON `{maxTokens, maxSeconds, tokensIn, tokensOut, usd?}`: the first
  two are the *limits* the runner enforces, the rest are what the run spent;
- `progress_done`/`progress_total` for the jobs rail;
- `attempts` for the retry policy (§2).

**Outputs are always write-tool calls.** A job never writes to the DB directly
and never touches a shard. If a job kind needs a write the tools do not offer,
the tool is added first (spec 17), not bypassed.

## 2. Runner

### 2.1 Process model — options and the recommendation

| option | what | pro | con |
|---|---|---|---|
| (a) in-process | the model call happens inside the UI server process | simplest; no IPC; trivial cancellation of the HTTP call | a runaway job stalls the server's event loop; no OS-level isolation; the agent's own tool loop must be reimplemented |
| (b) **spawned headless CLI agent per job** | one child process per job (`claude -p …`/an agent SDK entry point) with our MCP server attached | real isolation (kill the pid to cancel, cap memory/time); the agent's tool loop, retries and MCP client are the vendor's, not ours; the worker reaches the project only through the same MCP surface an external client uses — one code path to secure | process spawn cost per job (~hundreds of ms, irrelevant next to a model call); needs a CLI/SDK on PATH |
| (c) remote | jobs dispatched to a remote worker pool | scale; shared cache | network, auth, and the project would have to leave the machine — against the local-first rule |

**Recommendation: (b), spawned per job**, with (a) available behind the same
`WorkerBackend` interface for backends that are a single HTTP call (no agent
loop needed — `suggest-name` on a small function does not need a subagent), and
(c) explicitly out of scope for v1 (§9 reserves it for the owner). The reason to
prefer (b) as the default is not performance, it is that **cancellation, resource
caps and blast radius are OS-level facts** rather than promises made by our own
code, and that a spawned agent talking to our MCP server exercises exactly the
surface external agents use — one path to review, one path to secure.

### 2.2 Queue

- Storage: the `jobs` table (§3). `claimNext()` is a single conditional UPDATE
  (`… WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,
  id LIMIT 1) AND status='queued'`) so two runners never take the same job.
- **Concurrency cap**: N in-flight jobs (default 2; the UI shows the cap). The
  runner pool is N loops of claim→run→finish; the cap is enforced by the pool
  size, not by advisory locking.
- **Fairness**: FIFO by `created_at, id`. A human-initiated job may be enqueued
  with `priority` later; v1 has no priority (recorded as debt in §9).

### 2.3 Cancellation

Cooperative + hard. `cancel(id)`:
- job `queued` → status `cancelled` immediately, never starts;
- job `running` → status `cancelled` and the backend's `AbortSignal` fires; a
  spawned backend kills the child. **The runner re-reads the job's status before
  writing any output** — a job cancelled mid-flight writes nothing. This is the
  load-bearing rule: cancellation must be a guarantee about *writes*, not about
  *processes*, because a process can always finish a millisecond before the kill.

### 2.4 Retry

At most `attempts ≤ 3`. Retry only on **transient** failure (spawn failure,
timeout, transport error, HTTP 429/5xx): job returns to `queued` with
`attempts+1` and a `job.failed` event carrying the reason. **Never retry** a
deterministic failure (bad input, unknown fn, schema-invalid output) — it fails
terminally with `status='failed'` and the error text. Backoff is the pool's next
claim; no timers in v1.

### 2.5 Where the model call goes

```ts
interface WorkerBackend {
  readonly id: string;
  run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse>;
}
```
One interface, four implementations: `FakeBackend` (deterministic, in-repo, the
only one tests use), `CliBackend` (spawn, §2.1b), `SdkBackend` (agent SDK in
process), `HttpBackend` (a single model call). The runner knows nothing about
models: it builds a request from project reads (`McpResources`), hands it to the
backend, validates the response against the job kind's output schema, and turns
it into write-tool calls. **A backend that returns something the kind's schema
rejects fails the job; it never writes a half-understood result.**

## 3. Presence

- **Session**: a row per participant — `kind: human | worker | external`, `who`
  (an email, `worker:explain-fn`, an MCP client id), `opened_at`, `last_seen`,
  `closed_at`, `meta` JSON.
- **Heartbeat + TTL**: a session is *live* while `last_seen` is within the TTL
  (default 30 s; the UI beats every 10 s). Expiry is computed on read and swept
  by `Presence.expire()` — no background timer is required for correctness, so
  a crashed UI cannot hold state forever.
- **Claims**: a soft, advisory lock on a target (`fn:N`, `mod:N`) with
  `acquired_at`/`expires_at`. `PRIMARY KEY(target)` — one holder at a time. A
  claim is *advisory*: it is what draws "Fred is editing this function" and what
  stops two workers racing on the same function; it never blocks a write, because
  the store is append-only and supersession already resolves concurrent writes
  (spec 11). Expired claims are reclaimable by anyone; the holder refreshes by
  re-claiming.
- **Progress events**: `job.progress` with `done/total` — the jobs rail and any
  subscriber read them from the event stream (§4).

## 4. Provenance and promotion

**Rule: AI output never silently becomes truth.**

- Every worker write carries `prov = { source: "llm", who: "worker:<kind>",
  run: "<jobId>" }`. That is the provenance the revision store already records
  (`src/project/schema.ts`'s `Provenance`), and it is exported into the shard and
  the log unchanged.
- A worker's *proposal* lands as an **annotation** (`add_comment`) whose body is
  prefixed `[ai-suggested]` and which names the job id. Comments are the right
  home for a suggestion: they are additive, they never displace a human's name,
  and they already carry provenance.
- The **name slot is truth** and is only written by promotion:
  - **human acceptance** — the UI's accept action calls `set_name` with the
    human's own provenance (`source: "human"`), or
  - **a fidelity check** — a mechanically verified result (spec 17's
    `request_fidelity_check` PASS) may promote with `source: "tool"`.
  Rejection writes nothing; the suggestion comment stays as history.
- **Known gap (follow-up, not fixed here).** `src/mcp/tools.ts` has **no
  `tier`/`author` field**: `SetNameInput`/`AddCommentInput` carry `prov`
  (`source`/`who`/`run`) and nothing else. `prov.source === "llm"` is therefore
  the *de facto* suggested marker, and the `[ai-suggested]` body prefix is what
  the UI greps. The proper fix — an explicit `tier: "suggested" | "accepted"`
  on the write tools, so a suggested name can occupy the name slot greyed out —
  belongs to the owner of `src/mcp/tools.ts` and is filed as a follow-up. This
  spec deliberately does not write an unpromoted name into the name slot, so it
  is correct with or without that field.

### 4.1 What lands in spec-18 shards and the log

Spec 18 §4's boundary rule decides this, and it decides it against the brief's
first instinct:

- **Worker *outputs* are authoritative** — they are annotations written through
  `McpTools`, so they already land in `analysis/annotations/<module>.json`, in
  the `log` table, and in the exported hash-chained `log/<date>.jsonl`, with
  `actor_source='llm'`. Nothing new is needed for them.
- **Sessions, jobs and claims are operational state, NOT authoritative
  analysis** → they are **not exported to shards**, they are not git-tracked,
  and `hbcproj verify --full` / `export` / `rebuild` are unaffected by them.
  They live only in `cache.db`, which spec 18 §2 already calls disposable. A
  job that produced nothing is not part of the project's analysis; a job that
  produced something left its trace in the annotation it wrote.
- **Event stream**: the lifecycle events below are appended to an append-only
  `worker_events` table (a *change feed*, spec 21 §1.2's mechanism), not to the
  `log` table. Two reasons: (1) spec 18's log is the durable, hash-chained
  record of authoritative writes and job churn is not one of those; (2)
  `src/projdb/export.ts` keys every exported log entry by `log.rid` (it selects
  `rid` and emits it *as* `seq`), so rows without a revision would corrupt the
  exported chain's sequence. Recorded as **PUSHBACK P-15**.

**Event types (exact list).**

`session.open` · `session.close` · `job.queued` · `job.started` ·
`job.progress` · `job.done` · `job.failed` · `job.cancelled` ·
`claim.acquire` · `claim.release`

Each event is `{seq, ts, type, session?, job?, target?, detail?}` with `detail`
a small JSON blob (progress counters, error text, expiry reason). The stream is
append-only (trigger-enforced, like `log`), monotonic by `seq`, and is the feed
the UI tails.

## 5. Optional MCP capabilities (used when offered, never depended on)

- **Sampling** — if a connected client advertises `sampling`, a job may be run
  *through that client's model* instead of a server-owned backend (a
  `SamplingBackend` implementing `WorkerBackend`). It is an optimisation
  (the human's subscription pays, no key needed on the server), never the
  mechanism: with no sampling-capable client attached, everything still works.
- **Elicitation** — used for the *human* decisions: "accept this name?",
  "this job wants network access, allow?". Where elicitation is unavailable the
  same question appears in the UI's jobs rail; the server never blocks on it.
- **Subscriptions** — `log://tail` (the spec-18 log, the truth feed) and
  `inbox://<session>` (this session's pending questions/results). A notification
  says *something changed*; the subscriber then reads the feed (spec 21 §1.3's
  pairing: notification as the doorbell, log as the truth). Clients that do not
  subscribe poll — the MVP's 1 s poll (spec 22 §1) is exactly this.

## 6. UI surface (contract only — the UI is built later)

- **Jobs rail**: list of jobs with kind, target, status, progress bar, cost,
  cancel button; feeds from `worker_events` + `jobs`.
- **Presence markers**: an avatar/initials chip on a function or module that
  someone (human, worker, external) currently claims; a "claimed by worker"
  chip is what makes the Google-Docs feel legible rather than spooky.
- **Accept/reject**: on every `[ai-suggested]` annotation — accept calls
  `set_name`/`set_finding_status` with the human's provenance (§4), reject
  writes nothing. Both are ordinary entries in spec 22 §3.1's action registry,
  so they get a keybinding and a context-menu item for free.
- Server routes (owned by the ui-server track, listed here as the contract):
  `POST /jobs`, `GET /jobs`, `POST /jobs/:id/cancel`, `POST /sessions`,
  `POST /sessions/:id/heartbeat`, `DELETE /sessions/:id`, `POST /claims`,
  `DELETE /claims/:target`, `GET /events?since=<seq>`.

## 7. Security

- A worker runs with the **project directory only** as its working set; it is
  given the project path and nothing above it.
- **No network** unless the job kind declares it (`rerun-findings` may consult
  the offline OSV slice — still no network; nothing in v1 requires egress). The
  model call itself is the backend's business, not the job's: a job never
  fetches.
- **The recompile warning is carried through.** `recompile_edit` "PRODUCES A
  MODIFIED BINARY, not a read-only answer" (spec 17 §13). No worker may call it
  unattended: `poc-finding` proposes the edit and the human runs it. If that is
  ever relaxed, the warning text and the `{kind:"edited-and-recompiled"}`
  watermark travel with the job's result, unmodified.
- Workers never write to `analysis/`, `log/` or the bundle directly — only
  through the write tools, which is what makes the pre-commit hook and
  `verify --full` still meaningful in a world with AI writers.
- Secrets: a backend's API key comes from the environment of the server process
  and is never written into a job row, an event, or a shard.

## 8. Testing

- **`FakeBackend`** is the only backend the gate uses: deterministic replies
  keyed by job kind and input, no network, no spawn. Every runner test is
  therefore fully deterministic and offline.
- **Deterministic job runs**: enqueue → `runUntilIdle()` → assert the exact
  annotations, job status, cost fields, and the event sequence.
- **Idempotency**: the same key twice yields one job and one
  `job.queued` event.
- **Cancellation**: a job cancelled while running writes nothing.
- **Presence TTL**: an injected clock (`now()`) advances past the TTL; the claim
  becomes reclaimable, the stale session is closed, and the events are emitted.
- **Storage invariants**: after a run, `exportProject` writes **no** shard for
  sessions/jobs/claims, and the existing `tests/projdb/**` suite (export,
  rebuild, verify, status/adopt, log chain) passes unchanged.
- **Migration**: a schema-minor-1 DB (no worker tables) opens, is migrated in
  place, and its existing rows are untouched.

## 9. Reserved for the owner

1. **Backend choice** — headless CLI (`claude -p`) vs an agent SDK vs a plain
   HTTP call, and whether the default ships enabled at all.
2. **Model per job kind** — a cheap model for `suggest-name`, a strong one for
   `explain-fn`/`poc-finding`? The interface allows per-kind backends; the
   mapping is the owner's.
3. **Remote workers** (§2.1c) — off by default; would need auth and would move
   project bytes off the machine.
4. **Cost caps** — per job, per session, per day; and what happens at the cap
   (queue, refuse, ask via elicitation).
5. **Auto-promotion** — whether a fidelity-checked result may promote itself to
   the name slot without a human (§4 allows it, gated to `source:"tool"`), or
   whether promotion is always human.
6. **Priority queue** — v1 is FIFO (§2.2); whether human-initiated jobs jump the
   queue.

## Review responses

_(none yet — awaiting review)_

---

## 10. HTTP surface (as built, wave 3)

`src/ui-server/workers-routes.ts` implements §6's contract, spliced into
`src/ui-server/routes.ts`'s single route table (`BASE_ROUTES ++
WORKER_ROUTES`), so there is still exactly one `handle()` and one place a
request can 404. Every route answers **503** `{reason}` when the server was
started with `--workers off` or the project has no `.hbcproj` — an empty
list would read as "nothing to do", which is a different fact.

| route | in | out |
|---|---|---|
| `GET /api/jobs[?status=]` | `status` ∈ queued\|running\|done\|failed\|cancelled | `{rows: JobRow[], total, backend, concurrency}` |
| `POST /api/jobs` | `{kind, input, idempotencyKey?, createdBy?}` | `EnqueueResult` (`{job, deduped}`) |
| `POST /api/jobs/{id}/cancel` | — | `{cancelled, job}`; 404 on an unknown id |
| `GET /api/sessions` | — | `{rows: Session[], total}` — **live only** (`Presence.expire()` runs first, §3's compute-on-read TTL) |
| `POST /api/sessions` | `{kind, who, meta?}` | the `Session` |
| `POST /api/sessions/{id}/heartbeat` | — | `{id, live}`; 404 when not open |
| `GET /api/worker-events?since=` | `since` = last applied `seq` | `{rows, cursor}` — **exactly `/api/log/tail`'s cursor contract**: oldest-first, cap 500, `cursor` = highest seq returned or `since` when nothing was new |
| `GET /api/suggestions[?fn=]` | — | `{rows: SuggestionRow[], total}` |
| `POST /api/suggestions/promote` | `{kind:"name", target, rid\|name, prov?}` | `McpTools.promote`'s `ToolResult`; 400 when the rid is not a live suggestion |
| `POST /api/suggestions/reject` | `{rid}` | `{rid, rejected, recorded, wrote:false}` |

`JobRow` is the stored `Job` plus two server-computed fields, so no client
re-derives them: `target` (the `fn:N`/`mod:N` the job works on) and
`elapsedMs` (running-so-far, or the finished duration, or `null` while
queued).

`SuggestionRow` is `{rid, target, fn, kind:"name"|"comment", text, who, run,
ts, rejected}`. `kind:"name"` rows come from
`ProjectService.listSuggestedNames` (`tier:"suggested"` revisions) and are
promotable by `rid`; `kind:"comment"` rows are the `[ai-suggested]`
annotations (§4) and are informational — a comment has no truth slot to be
promoted into.

**Events channel.** `/api/events` (the existing SSE endpoint) now carries a
**second channel on the same socket**: `event: worker` frames with the same
`{rows, cursor}` shape, starting from `?workerSince=` or the feed's current
head. One connection, two feeds; a client that only wants the log ignores
the frame, and polling `/api/worker-events` remains equivalent.

### 10.1 Rejection: what §4 means operationally

§4 says "Rejection writes nothing; the suggestion comment stays as history",
and that is implemented literally: `POST /api/suggestions/reject` mints **no
revision, no annotation, no log row** (`wrote: false` in the response says so
explicitly). It could not do otherwise even if we wanted it to — `TAGS`
(`src/project/schema.ts`) is a closed taxonomy with no `rejected` member, and
`worker_events.type` is closed by a CHECK constraint. The rejection is noted
on the **job row** (`jobs.result.rejected: string[]`), which §4.1 already
classifies as operational state: never exported to a shard, never in the
hash-chained log, disposable with the rest of the DB's cache tables. The UI
greys the row and hides the Accept button; the suggestion itself survives.

A rejection whose rid belongs to no job (a suggestion written by an external
MCP client, say) answers 200 with `recorded: false` — nothing to note it on,
and nothing was written, which is the honest result.

### 10.2 The default backend (§9 item 1, decided)

`src/workers/backends/heuristic.ts`'s **`HeuristicBackend`** ships enabled by
default. It is not a model: it derives a name from the function's own
most-used callee (`dispatchEvent` → `dispatchEventHandler`) or, failing that,
from its string literals, and an explanation from the summary the runner
already read (params, callees, strings). No key, no network, no spawn, and
**deterministic** — the same request gives the same text, so it is asserted
in the gate like a pure function and a human auditing provenance can
reproduce a suggestion exactly.

That is what makes §9 item 1 answerable "yes, ship it on": the risk the
question was really about (cost, egress, a key on the server) is zero here,
and the end-to-end product loop — enqueue → running → done → suggestion →
promote/reject — is real today. `CliBackend`/`SdkBackend`/`HttpBackend`
remain drop-in through the same `WorkerBackend` interface with nothing else
changing. `--workers off` disables the pool entirely.

The runner runs it with `writeSuggestedNames: true` (an opt-in added this
wave, default off): a `suggest-name` proposal lands as a `tier:"suggested"`
`set_name` **as well as** the `[ai-suggested]` comment. That is exactly the
"occupy the name slot greyed out" state §4 described as the proper fix once
`tier` existed — spec 17 §15 has since added it — and it gives
`McpTools.promote({kind:"name", target, rid})` an rid to resolve instead of
making the UI re-type a name out of a comment body. Nothing about §4's rule
changes: the suggested name is not truth, and promotion under the human's own
provenance is what makes it so.
