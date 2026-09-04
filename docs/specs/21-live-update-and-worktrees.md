# 21 — Live update (simultaneous UI + MCP) and git worktrees (investigation)

**Status: INVESTIGATION (2026-09-04, Fable). Decision-support only — nothing
here is decided, specified, or built.** This document investigates two open
questions raised by spec 19 (Stage-3 UI) and spec 18 (files-first project
storage): (1) how a live UI and an MCP-driven agent operate on ONE project
simultaneously, with each seeing the other's writes as they happen; and (2)
whether git worktrees are the right isolation model, and if so, for what. It
ends with a clear recommendation; the fundamentals (§5) are the owner's
decision, in the spec-17 §6 / spec-19 §5 tradition. The owner rules; this
document informs.

Reading list: `docs/specs/19-ui-investigation.md` §0 (the UI is a graphical
client of the spec-17 contract — same store, same caps, same tests), §5 (the
fundamentals reserved for the owner, which this doc extends not replaces);
`docs/specs/18-project-storage-integrity.md` §5–§8 (per-shard content hash,
hash-chained append-only `log/`, DB-first compound write path, content-hash
finding IDs), §10 (`status`/`diff`/`adopt`/`restore` three-way porcelain);
`docs/specs/17-mcp-harness.md` §13 (`recompile_edit` — the one tool that
PRODUCES a modified binary), §14 (the write side: evidence-gated, logged,
replayable).

## 0. Framing: what "live" has to mean, and what it doesn't

The operating model is unchanged from spec 19 §0: **single analyst, local
machine, one `.hbcproj` open at a time.** "Simultaneous UI + MCP" does not
mean a multi-user server. It means the ordinary local case where the analyst
has the UI open AND an agent is driving the same project through MCP (or the
CLI) in the same session — two *transports*, one project. Spec 19's central
recommendation is that the UI and MCP are two transports over ONE service pair
(`McpResources`/`McpTools`) in one Node process, so shared state is true by
construction, not by synchronisation.

"Live update" is therefore the narrow problem: **when a write commits through
the shared service, every attached view learns about it promptly and applies
the minimal delta, without re-fetching the whole project.** The write path
itself (contention, ordering, atomicity) is already solved by spec 18 — the
live layer only has to *fan out* what spec 18 already records.

## 1. Live update — mechanism comparison

Spec 18's write path (§6) is: validate → commit to `cache.db` in one
transaction → export the affected shard(s) to hash-locked JSON → append ONE
hash-chained entry to `log/<date>.jsonl` carrying `seq`, `op`, affected shard
id(s) + their post-write content hashes, `provenance` (`mcp | cli |
human-file-edit`), and (per the step-2 landing) the write's own `slot`/`value`.
Four candidate mechanisms fan this out to views:

| # | Mechanism | Source of truth for the delta | Works across processes? | Reuses existing design? | Ordering guarantee |
|---|---|---|---|---|---|
| a | In-process event bus (service emits a change event; UI subscribes via WS/SSE) | the write call itself | no (same process only) | new code, but small | emission order = write order |
| b | Tail the append-only `log/` as the change feed | spec 18's log (already written) | **yes** | **fully — the log already exists** | **`seq` is monotonic by construction** |
| c | File-watch `analysis/` shards (`fs.watch`/chokidar) | shard mtime/content change | yes | partial | none — coalesced, unordered, no seq |
| d | DB change hooks (SQLite `update_hook`/`sqlite3_session`) | the DB | no (in-process C callback) | new code | commit order, but DB-only |

### 1.1 Why (c) and (d) are wrong here

**(c) file-watch is the classic trap.** `fs.watch` reports "something under
`analysis/` changed", not *what* or *in what order*. Editors and atomic-rename
writes emit multiple events per logical change; the watcher must then re-read
and diff shards to discover the delta — reintroducing the whole-project reads
spec 17 §14 spent its entire surface revision eliminating. It also can't
distinguish an hbc2js write from a hand edit (spec 18 §10's whole point), and
gives no total order. Reject.

**(d) DB change hooks** are in-process only (a C callback in the same process
that holds the connection), so they can never serve a second process — and if
you're already in-process, (a) is simpler and doesn't couple the live layer to
SQLite internals (spec 18 §8: the DB is *disposable*; the live feed should not
depend on which store happens to be operational). Reject as the primary.

### 1.2 The log-as-change-feed insight (b) is the load-bearing one

Spec 18 already built a monotonic, hash-chained, append-only record of *every*
write, tagged with affected shard ids and post-write hashes. **That is
precisely a change feed.** A subscriber does not need any new persistence, any
new ordering primitive, or any new "did I miss one" logic — it needs a cursor
(`lastSeq`) and a rule: on new entries, fetch the entries after `lastSeq`,
apply each in `seq` order (invalidate/refetch exactly the shard ids each entry
names — a bounded, addressable read the spec-17 surface already serves), and
advance the cursor. Properties fall out for free:

- **Ordering / consistency.** `seq` is monotonic (spec 18 §5/§7); apply in
  `seq` order and every view converges to the same state. The hash chain means
  a subscriber can *detect* a gap or tamper, not just hope.
- **Catch-up = replay.** A view that was closed, or a UI that reconnects after
  a dropped socket, replays from its last `seq` — the exact same code path as
  live tailing. No separate "initial sync" vs "live" logic.
- **Cross-process for free.** Because the feed is a file, a UI in a *different*
  process from the MCP server (spec 19 §5.2 / Option D leaves this open) still
  works with zero extra machinery. This future-proofs the transport decision
  the owner hasn't made.
- **Multiple simultaneous writers are already handled.** Spec 18 §7's
  content-hash finding IDs and sharded annotation files make annotation writes
  **contention-free** (same finding ⇒ same id ⇒ dedup; different shards ⇒ no
  conflict; DB-first §6 serialises the compound write and assigns the one
  `seq`). The live layer inherits this: it never arbitrates, it only fans out.
  Two agents writing different modules produce two log entries with distinct
  `seq`s; every view applies both, in order.

### 1.3 The pragmatic pairing: (a) as the notification, (b) as the truth

There is one real cost to pure (b): *latency and efficiency of noticing*.
Polling a file for new lines is either laggy (long poll interval) or wasteful
(tight poll). The clean resolution keeps the log as the **source of truth for
deltas** and uses the in-process bus (a) purely as a **zero-latency
"something changed past seq N" doorbell**:

1. A write commits through the shared service (spec 19's one process).
2. The service appends the log entry (spec 18 §6 step 3) — unchanged.
3. The service emits an in-process `wrote(seq, shardIds)` event.
4. The live endpoint (WS or SSE — owner's choice, §5) forwards a tiny
   `{seq}` notification to attached views.
5. Each view, on notification (or on reconnect), reads log entries after its
   cursor and applies them by `seq`, refetching only the named shards.

The log remains authoritative and self-sufficient: if the doorbell is missed
(crash, reconnect, or a *second process* with no in-process bus), a view falls
back to tailing/polling the log and loses nothing — same code path. (a) is an
optimisation over (b), never a replacement. A hand edit adopted via spec 18
§10 (`adopt`) goes through the same write verbs (per the step-3 landing), so it
mints a log entry too — meaning **hand edits also appear live**, with
`provenance: human-file-edit`, for free.

This is the same layering discipline spec 18 used (DB operational, JSON
durable authority): here the **bus is operational, the log is the authority.**

## 2. The worktree question

Spec 18 §7 makes annotation/finding writes contention-free without any
filesystem isolation. So the honest question is not "worktrees yes/no"
globally — it is **which activities actually mutate the shared *working copy* of
source or bundle**, because only those need isolation. Three candidates:

### 2.1 (a) Speculative source edits / `recompile_edit` — YES, isolate

`recompile_edit` (spec 17 §13) is the one operation in the whole system that
**produces a modified binary**: it edits a function's source, recompiles with
`tools/hermesc/vNN`, and splices into a *copy* of the bundle. Its spec already
says "never mutates the original bundle or the `.hbcproj`". But the *edited
source tree* it compiles from is exactly the kind of speculative, throwaway,
possibly-broken state that must not touch the analyst's shared `src/` working
copy (spec 18 §3 puts split output under `<outDir>/src/`). This is the textbook
worktree use: a cheap, disposable, git-native sandbox that shares object
storage with the main checkout, where an agent can patch-recompile-run-compare
and then be torn down (`git worktree remove`) with zero residue. The AGENT-LOG
already shows the team using `git worktree add` + `hermesc` builds this way for
VM work — the pattern is proven in-repo. **Recommendation: worktrees ARE
warranted here.** One ephemeral worktree per `recompile_edit` experiment (or
per agent running such experiments), torn down after.

### 2.2 (b) Version-diff / comparing two app versions (P2.5) — YES, natural fit

Comparing two versions of an app means having two full source/bundle trees
materialised at once. Two worktrees (or two checkouts) is the natural,
git-native way to hold both without one clobbering the other, and lets the
existing per-version tooling run against each in place. **Recommendation:
worktrees (or plain sibling checkouts) are warranted here** — this is genuinely
two working copies, which is exactly what a worktree *is*. Note the
`.hbcproj` is per-bundle (spec 16), so each version has its own project store;
no annotation-merge problem arises, only a source/bundle isolation one.

### 2.3 (c) A UI user experimenting while agents work — NO, overkill

This is the case the contention-free design already dissolves. If the "UI user
experimenting" means making annotations/findings/renames, spec 18 §7 already
guarantees those never conflict with agent writes — content-hash IDs dedup,
sharded files don't collide, `seq` orders everything, and the §1 live layer
shows both parties each other's writes. A worktree here would *fragment* the
shared project the whole live-update design exists to keep unified — you'd then
need a merge step to reconcile two `.hbcproj` states, reintroducing exactly the
contention spec 18 removed. **Recommendation: NO worktree.** The shared
live-updated project IS the collaboration surface. (If a UI user wants to
experiment with *source edits/recompiles*, that falls under §2.1, not here.)

### 2.4 Worktree verdict

> **Worktrees for source-edit / `recompile_edit` sandboxes (§2.1) and for
> version comparison (§2.2). NOT for annotations, findings, or concurrent
> analysis of one version (§2.3) — those are already contention-free and are
> better served by the shared, live-updated project.**

A simpler alternative worth the owner's consideration for §2.1: since
`recompile_edit` already compiles into a *copy* of the bundle and writes a
clearly-watermarked synthetic artifact, a plain scratch directory (temp dir
per experiment) may suffice when the edit is a single-file patch — the full
git-worktree machinery earns its keep mainly when the experiment needs the
whole source tree and git's diff/history to reason about the change. Worktrees
are the right tool when you want git-native diffing and teardown; a temp copy
is enough for a one-shot patch-and-run.

## 3. Recommendation

**Live update:** adopt **(b) the append-only `log/` as the change feed, with
(a) the in-process event bus as a zero-latency doorbell** (§1.3). The log is
the authority (monotonic `seq`, hash-chained, already written by spec 18 §6);
the bus only says "there is something past `seq N`". This reuses spec 18's
design wholesale, gives ordering/consistency and catch-up/replay for free,
handles multiple simultaneous writers by inheritance (spec 18 §7), works
across processes, and treats hand edits (§10 `adopt`) as first-class live
events. Reject file-watch (c, no order, whole-shard re-reads) and DB hooks (d,
in-process only, couples to the disposable store) as primaries.

**Worktrees:** adopt for **source-edit / `recompile_edit` sandboxes and
version comparison**; do NOT adopt for annotation/finding collaboration on one
version (already contention-free). See the §2.4 verdict.

## 4. Consequences if adopted (informative, not decided)

- The service gains one internal event (`wrote(seq, shardIds)`) emitted right
  after spec 18 §6 step 3. No new store, no new ordering primitive.
- A view/client gains a cursor (`lastSeq`) and a delta-apply loop keyed on
  shard ids. Testable in text: replay a known log → assert converged state;
  drop the doorbell → assert catch-up via log tail still converges.
- `recompile_edit`'s lifecycle gains a worktree/scratch create+teardown step;
  its "never mutates the original" guarantee (spec 17 §13) becomes structurally
  enforced, not just promised.

## 5. Reserved for the owner (the actual decision)

Per the spec-17 §6 / spec-19 §5 pattern, this investigation argues but does not
pre-commit the following; they interlock with spec 19 §5's already-reserved
transport/process decisions:

1. **Live-update wire transport — WebSocket vs SSE.** SSE is simpler
   (one-way server→client, which is all the doorbell needs; writes go through
   the normal request path), auto-reconnects, and rides plain HTTP. WebSocket
   is bidirectional (useful only if the UI ever pushes over the same channel).
   The §1.3 design works over either; the choice is the owner's, and ties
   directly into spec 19 §5.2's transport/serving-model decision (including
   Option D: the UI as just another MCP client, in which case the "live feed"
   might be an MCP resource/subscription rather than a raw socket).
2. **Whether worktrees are adopted at all**, and if so whether via git
   worktrees or plain scratch copies for the §2.1 case — and the sandboxing/
   isolation policy for the `recompile_edit` recompile+run step, which spec 17
   §13 already fenced off to the owner.
3. **Process / hosting model** — one process co-hosting UI+MCP (spec 19's
   recommendation, making the in-process bus trivial) vs separate processes
   (in which case the log-as-feed becomes the *only* mechanism, and the bus
   drops out). This is spec 19 §5.2's single-writer question; the §1 design is
   deliberately correct under both, so it does not force the owner's hand.
4. **Long-lived-server ↔ `.hbcproj` `-wal` hand-off** (spec 16 §1.1) under a
   persistently-attached live UI — an extension of spec 19 §5.2's same concern.

The recommendation of this investigation is (b)+(a) for live update and the
§2.4 worktree verdict; the fundamentals above are the owner's.
