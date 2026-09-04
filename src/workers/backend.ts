// src/workers/backend.ts — the pluggable model boundary
// (docs/specs/23-ui-workers.md §2.5). The runner knows nothing about models:
// it builds a request from project reads, hands it to a `WorkerBackend`, and
// validates what comes back against the job kind's output shape. Four
// implementations are foreseen — `FakeBackend` (here; deterministic, offline,
// the ONLY backend the gate uses), `CliBackend` (spawn a headless CLI agent
// per job, §2.1's recommendation), `SdkBackend` (agent SDK in process) and
// `HttpBackend` (one model call) — and none of them is in the gate's path.
import type { JobKind } from "./queue.ts";

export interface WorkerJobRequest {
  readonly kind: JobKind;
  /** The instruction; backends that wrap an agent pass it as the prompt. */
  readonly prompt: string;
  /** Project reads the job already paid for (source, summary, xrefs…) — a
   *  backend must never go and fetch its own (§7: a job never fetches). */
  readonly context: Record<string, unknown>;
  readonly maxTokens?: number;
  readonly maxSeconds?: number;
}

export interface WorkerJobResponse {
  readonly text: string;
  readonly cost?: { readonly tokensIn?: number; readonly tokensOut?: number; readonly usd?: number };
}

export interface WorkerBackend {
  readonly id: string;
  run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse>;
}

/** A backend failure the runner should treat as transient (§2.4: spawn
 *  failure, timeout, transport error, 429/5xx). Anything else is terminal. */
export class TransientBackendError extends Error {}

export type FakeReply = (req: WorkerJobRequest) => string;

/** Deterministic, offline, no spawn. Default replies are a pure function of
 *  the request, so a runner test asserts an exact annotation body without any
 *  model in the loop; `replies` overrides per kind, and `failKinds` makes a
 *  kind throw (terminal or transient) to exercise the failure paths. */
export class FakeBackend implements WorkerBackend {
  readonly id = "fake";
  private readonly replies: Partial<Record<JobKind, FakeReply>>;
  private readonly failKinds: Partial<Record<JobKind, { readonly message: string; readonly transient: boolean }>>;
  /** Every request seen, in order — lets a test assert the runner did NOT
   *  call the backend for a cancelled job. */
  readonly seen: WorkerJobRequest[] = [];

  constructor(
    opts: {
      readonly replies?: Partial<Record<JobKind, FakeReply>>;
      readonly failKinds?: Partial<Record<JobKind, { readonly message: string; readonly transient: boolean }>>;
    } = {},
  ) {
    this.replies = opts.replies ?? {};
    this.failKinds = opts.failKinds ?? {};
  }

  async run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse> {
    this.seen.push(req);
    if (signal?.aborted === true) throw new TransientBackendError("aborted");
    const fail = this.failKinds[req.kind];
    if (fail !== undefined) {
      throw fail.transient ? new TransientBackendError(fail.message) : new Error(fail.message);
    }
    const custom = this.replies[req.kind];
    const text = custom !== undefined ? custom(req) : defaultReply(req);
    return { text, cost: { tokensIn: req.prompt.length, tokensOut: text.length } };
  }
}

function defaultReply(req: WorkerJobRequest): string {
  const target = String(req.context["target"] ?? "unknown");
  switch (req.kind) {
    case "suggest-name":
    case "name-module":
      // A name-shaped answer derived only from the target, so it is stable
      // across runs and readable in an assertion.
      return `fake${target.replace(/[^A-Za-z0-9]/g, "")}`;
    default:
      return `fake explanation of ${target}`;
  }
}
