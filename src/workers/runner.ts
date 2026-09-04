// src/workers/runner.ts — the server-owned worker loop
// (docs/specs/23-ui-workers.md §2, §4). Claims a job, gathers the reads the
// kind needs through `McpResources`, calls a `WorkerBackend`, and lands the
// answer through `McpTools` — the SAME write tools a human in the UI and an
// external MCP client use, which is what makes provenance hold (spec 23 §0).
//
// Two rules this file exists to enforce:
//
//  1. **AI output never silently becomes truth (§4).** A worker write is an
//     ANNOTATION (`add_comment`) whose body is prefixed `[ai-suggested]` and
//     which carries `prov = {source:'llm', who:'worker:<kind>', run:<jobId>}`.
//     A proposed NAME is never written into the name slot by the worker: the
//     name is truth, and only `accept()` — a human's action, with the human's
//     own provenance — or a fidelity check promotes it. (`src/mcp/tools.ts`
//     has no `tier`/`author` field today; `prov.source==='llm'` plus the body
//     prefix IS the suggested marker, and adding an explicit `tier` is spec 23
//     §4's recorded follow-up for that file's owner.)
//  2. **Cancellation is a guarantee about WRITES (§2.3).** The job's status is
//     re-read after the backend returns and before anything is written; a job
//     cancelled mid-flight writes nothing at all.
import type { DatabaseSync } from "node:sqlite";
import type { McpResources } from "../mcp/resources.ts";
import type { McpTools } from "../mcp/tools.ts";
import type { Provenance } from "../project/schema.ts";
import { TransientBackendError, type WorkerBackend, type WorkerJobRequest } from "./backend.ts";
import { JobQueue, type Job, type JobKind } from "./queue.ts";
import type { Presence } from "./presence.ts";

/** Body prefix every worker-written annotation carries (§4). The UI greps it
 *  to draw the accept/reject affordance. */
export const SUGGESTED_PREFIX = "[ai-suggested]";

/** What a finished job records in `jobs.result` (§4): the tier, the proposal
 *  (for a kind that proposes something promotable), and the writes it made. */
export interface JobResult {
  readonly tier: "suggested" | "accepted";
  readonly kind: JobKind;
  readonly text: string;
  readonly proposal?: Record<string, unknown>;
  readonly writes: readonly { readonly tool: string; readonly target: string; readonly rid: string }[];
}

export interface WorkerRunnerOpts {
  readonly db: DatabaseSync;
  readonly resources: McpResources;
  readonly tools: McpTools;
  readonly backend: WorkerBackend;
  readonly queue?: JobQueue;
  readonly presence?: Presence;
  /** The worker's own session id, when one was opened (§3). */
  readonly sessionId?: string;
  /** Source-line cap handed to the backend — the token-hygiene rule applies to
   *  a worker exactly as it does to an agent. */
  readonly sourceLines?: number;
  /** Additive (spec 23 §4's "known gap", now closed by spec 17 §15's `tier`):
   *  when true, a `suggest-name` job ALSO records its proposal as a
   *  `set_name` write carrying `tier:"suggested"`, so the suggestion has a
   *  revision id a human can promote by rid (`McpTools.promote`) instead of
   *  the UI having to re-type the name out of a comment body. It is still a
   *  SUGGESTION, never truth: `tier:"suggested"` is exactly the "occupy the
   *  name slot greyed out" state §4 describes, and promotion — a human's own
   *  provenance — is what makes it accepted.
   *
   *  Default OFF, because §4 was written when `tier` did not exist and
   *  deliberately wrote nothing into the name slot; the ui-server turns it on
   *  (`src/ui-server/workers-routes.ts`) so the UI's accept/reject flow has
   *  something to accept. */
  readonly writeSuggestedNames?: boolean;
}

export class WorkerRunner {
  readonly queue: JobQueue;
  private readonly db: DatabaseSync;
  private readonly resources: McpResources;
  private readonly tools: McpTools;
  private readonly backend: WorkerBackend;
  private readonly presence: Presence | undefined;
  private readonly sessionId: string | undefined;
  private readonly sourceLines: number;
  private readonly writeSuggestedNames: boolean;

  constructor(opts: WorkerRunnerOpts) {
    this.db = opts.db;
    this.resources = opts.resources;
    this.tools = opts.tools;
    this.backend = opts.backend;
    this.queue = opts.queue ?? new JobQueue(opts.db);
    this.presence = opts.presence;
    this.sessionId = opts.sessionId;
    this.sourceLines = opts.sourceLines ?? 120;
    this.writeSuggestedNames = opts.writeSuggestedNames ?? false;
  }

  private prov(job: Job): Provenance {
    return { source: "llm", who: `worker:${job.kind}`, run: job.id };
  }

  /** The target id a job works on, in the `id.ts` vocabulary the write tools
   *  and the claim table both speak. */
  private targetOf(job: Job): string {
    if (typeof job.input["fn"] === "number") return `fn:${job.input["fn"] as number}`;
    if (typeof job.input["module"] === "number") return `mod:${job.input["module"] as number}`;
    return String(job.input["target"] ?? "project");
  }

  /** Builds the backend request for a kind — every read a job makes happens
   *  HERE, so §7's "a job never fetches" is structural. */
  private request(job: Job): WorkerJobRequest {
    const target = this.targetOf(job);
    const fn = typeof job.input["fn"] === "number" ? (job.input["fn"] as number) : undefined;
    const context: Record<string, unknown> = { target };
    if (fn !== undefined) {
      context["summary"] = this.resources.fn(fn);
      context["source"] = this.resources.source(fn, { lines: [1, this.sourceLines] }).text;
    }
    const prompt =
      job.kind === "suggest-name" || job.kind === "name-module"
        ? `Propose one identifier name for ${target}. Answer with the name only.`
        : `Explain what ${target} does, in a short paragraph.`;
    return { prompt, kind: job.kind, context, ...(job.cost?.maxTokens !== undefined ? { maxTokens: job.cost.maxTokens } : {}) };
  }

  /** Claims and runs one job. Returns the finished `Job`, or undefined when
   *  the queue is empty. */
  async runOne(): Promise<Job | undefined> {
    const job = this.queue.claimNext();
    if (job === undefined) return undefined;
    if (job.kind !== "explain-fn" && job.kind !== "suggest-name") {
      // Skeleton scope (spec 23 §1 lists the full kind table): every other
      // kind fails terminally rather than silently doing nothing.
      return this.queue.fail(job.id, `job kind not implemented yet: ${job.kind}`);
    }
    const target = this.targetOf(job);
    if (this.presence !== undefined && this.sessionId !== undefined) this.presence.claim(target, this.sessionId);
    try {
      const res = await this.backend.run(this.request(job));
      // §2.3: cancellation is a guarantee about WRITES — re-read before writing.
      const live = this.queue.get(job.id);
      if (live === undefined || live.status !== "running") return live;
      const text = res.text.trim();
      const body =
        job.kind === "suggest-name" ? `${SUGGESTED_PREFIX} name: ${text} (job ${job.id})` : `${SUGGESTED_PREFIX} ${text} (job ${job.id})`;
      const write = this.tools.addComment({ target, body, prov: this.prov(job), tier: "suggested" });
      const writes: { readonly tool: string; readonly target: string; readonly rid: string }[] = [
        { tool: "add_comment", target, rid: write.rid },
      ];
      // The proposed name as a `tier:"suggested"` revision (opt-in, see
      // `writeSuggestedNames`): it never displaces the accepted name, and it
      // gives `McpTools.promote({kind:"name", target, rid})` something to
      // resolve. Rule 1 still holds — nothing here is accepted.
      if (this.writeSuggestedNames && job.kind === "suggest-name" && text.length > 0) {
        const named = this.tools.setName({ target, name: text, prov: this.prov(job), tier: "suggested" });
        writes.push({ tool: "set_name", target, rid: named.rid });
      }
      const result: JobResult = {
        tier: "suggested",
        kind: job.kind,
        text,
        ...(job.kind === "suggest-name" ? { proposal: { name: text } } : {}),
        writes,
      };
      return this.queue.finish(job.id, { result, ...(res.cost !== undefined ? { cost: res.cost } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.queue.fail(job.id, message, { transient: err instanceof TransientBackendError });
    } finally {
      if (this.presence !== undefined && this.sessionId !== undefined) this.presence.release(target, this.sessionId);
    }
  }

  /** Drains the queue with at most `concurrency` jobs in flight (§2.2's cap).
   *  Returns every job it ran, in completion order. */
  async runUntilIdle(opts: { readonly concurrency?: number; readonly max?: number } = {}): Promise<readonly Job[]> {
    const concurrency = Math.max(1, opts.concurrency ?? 2);
    const max = opts.max ?? Number.POSITIVE_INFINITY;
    const done: Job[] = [];
    const loop = async (): Promise<void> => {
      for (;;) {
        if (done.length >= max) return;
        const job = await this.runOne();
        if (job === undefined) return;
        done.push(job);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => loop()));
    return done;
  }

  /** §4's promotion: a human (or a fidelity check, with `source:'tool'`) turns
   *  a `suggest-name` proposal into the truth in the name slot. The write
   *  carries the PROMOTER's provenance, never the worker's — that is the whole
   *  point. Returns the write's rid, or undefined when there is nothing to
   *  promote. */
  accept(jobId: string, prov: Provenance): string | undefined {
    const job = this.queue.get(jobId);
    if (job === undefined || job.status !== "done") return undefined;
    const result = job.result as JobResult | null;
    const name = result?.proposal?.["name"];
    if (typeof name !== "string" || name.length === 0) return undefined;
    const written = this.tools.setName({ target: this.targetOf(job), name, prov });
    this.db.prepare("UPDATE jobs SET result = ? WHERE id = ?").run(
      JSON.stringify({
        ...result,
        tier: "accepted",
        writes: [...(result?.writes ?? []), { tool: "set_name", target: this.targetOf(job), rid: written.rid }],
      }),
      jobId,
    );
    return written.rid;
  }
}
