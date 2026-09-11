// src/readability/name-pass.ts -- spec 28 section 1b's per-target loop, NAMES
// only (landing 1): gather -> cache -> skill -> generate -> validate -> write
// overlay -> equiv backstop. The cache-check and skill-load steps live inside
// the backend (`HaikuBackend`/`ReplayBackend` both consult the content-hash
// cache before any call, spec 28 section 9.3), so this file's own job is the
// generate/validate/write/verify half that is identical whether the batch CLI
// or a live UI worker drives it (spec 28 section 5, "one core, two callers").
//
// This module imports NO transport (interface-shape.test.ts enforces it for
// the whole `src/readability` directory): it takes a `WorkerBackend`, never
// constructs one.
import type { WorkerBackend, WorkerJobRequest } from "../workers/backend.ts";
import type { JobKind } from "../workers/queue.ts";
import { NameService } from "../name-overlay/service.ts";
import type { RenderOptions } from "../name-overlay/render.ts";
import { bindingKey } from "../name-overlay/id.ts";
import type { BindingId } from "../name-overlay/id.ts";
import { parseReadabilityResult } from "./types.ts";
import type { EquivProof, NameProposal } from "./types.ts";

/** One target the loop should propose a name for: a register local (landing
 *  1) or, in principle, any binding the overlay can hold. `context` is the
 *  full `get_context`-shaped payload the backend prompts with (spec 28
 *  section 9.1's table); `context.source` doubles as the cache key's `body`
 *  (spec 28 section 9.3). Callers build this from whatever they already have
 *  warm -- the CLI from a freshly parsed bundle, the runner from
 *  `McpResources` -- so gather stays outside this shared core. */
export interface NamePassTarget {
  readonly bindingId: BindingId;
  readonly kind: Extract<JobKind, "suggest-name" | "name-module">;
  readonly context: Record<string, unknown>;
}

export type NamePassSkipReason =
  | "backend-error"
  | "parse-error"
  | "abstained"
  | "gate-refused"
  | "budget-stopped"
  | "equiv-backstop-failed";

export interface NamePassOutcome {
  readonly target: NamePassTarget;
  readonly proposal?: NameProposal;
  readonly written: boolean;
  readonly reason?: NamePassSkipReason;
  readonly detail?: string;
}

export interface NamePassOptions {
  readonly backend: WorkerBackend;
  readonly service: NameService;
  /** Hard stop in tokens (spec 28 section 9.1's `budgetTokens`). Checked
   *  BETWEEN targets, never mid-write: a target already in flight always
   *  finishes writing before the loop stops. */
  readonly budgetTokens?: number;
  readonly renderOptions?: RenderOptions;
  readonly signal?: AbortSignal;
}

export interface NamePassResult {
  readonly outcomes: readonly NamePassOutcome[];
  readonly tokensUsed: number;
  readonly stoppedAtBudget: boolean;
  /** The section 9.4 NAME-row backstop: apply the whole batch's name set,
   *  render, revert it, render again -- PASS iff the two renders match. Run
   *  once per batch, not once per name (a correct alpha-rename is
   *  semantics-preserving by construction; this backstop is what makes that
   *  provable rather than assumed). */
  readonly equiv: EquivProof;
}

/** Run the per-target loop over `targets`, in the order given (callers do
 *  evidence-directed ordering, spec 28 section 3, before calling this). */
export async function runNamePass(targets: readonly NamePassTarget[], opts: NamePassOptions): Promise<NamePassResult> {
  const renderOptions = opts.renderOptions ?? {};
  const before = opts.service.render(renderOptions).code;

  const outcomes: NamePassOutcome[] = [];
  const written: { readonly id: BindingId; readonly ts: string }[] = [];
  let tokensUsed = 0;
  let stoppedAtBudget = false;

  for (const target of targets) {
    if (opts.budgetTokens !== undefined && tokensUsed >= opts.budgetTokens) {
      stoppedAtBudget = true;
      outcomes.push({ target, written: false, reason: "budget-stopped" });
      continue;
    }

    const req: WorkerJobRequest = { kind: target.kind, prompt: "", context: target.context };
    let text: string;
    try {
      const res = await opts.backend.run(req, opts.signal);
      text = res.text;
      tokensUsed += (res.cost?.tokensIn ?? 0) + (res.cost?.tokensOut ?? 0);
    } catch (e) {
      outcomes.push({ target, written: false, reason: "backend-error", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const parsed = parseReadabilityResult(text);
    if (!parsed.ok) {
      outcomes.push({ target, written: false, reason: "parse-error", detail: parsed.error });
      continue;
    }
    if (parsed.result.abstained || parsed.result.names.length === 0) {
      outcomes.push({ target, written: false, reason: "abstained" });
      continue;
    }

    const key = bindingKey(target.bindingId);
    const proposal = parsed.result.names.find((n) => bindingKey(n.bindingId) === key) ?? parsed.result.names[0];
    if (proposal === undefined) {
      outcomes.push({ target, written: false, reason: "abstained" });
      continue;
    }

    const set = opts.service.setName(target.bindingId, proposal.name, {
      confidence: proposal.confidence,
      evidence: proposal.evidence,
      source: "llm",
    });
    if (!set.ok) {
      outcomes.push({ target, proposal, written: false, reason: "gate-refused", detail: set.reason });
      continue;
    }
    written.push({ id: target.bindingId, ts: set.result.record.ts });
    outcomes.push({ target, proposal, written: true });
  }

  // The batch backstop (spec 28 section 9.4 NAME row): revert every write
  // this run made and render again; PASS iff that matches the pre-run render.
  for (const w of written) opts.service.revert(w.id);
  const restored = opts.service.render(renderOptions).code;
  const verdict = restored === before ? "PASS" : "DIVERGENT";
  const equiv: EquivProof = {
    scope: "name",
    verdict,
    oracle: "apply-then-revert render byte-identical",
    coverage: { inputs: written.length, records: written.length },
    ts: new Date().toISOString(),
  };

  if (verdict === "PASS") {
    // Re-activate every write the backstop just proved safe.
    for (const w of written) opts.service.revert(w.id, w.ts);
  } else {
    // Discard by construction (spec 28 section 0a): the whole batch's writes
    // stay reverted, and every outcome that looked written is corrected.
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o !== undefined && o.written) outcomes[i] = { ...o, written: false, reason: "equiv-backstop-failed" };
    }
  }

  return { outcomes, tokensUsed, stoppedAtBudget, equiv };
}

/** How many targets in `outcomes` actually got a name written -- the
 *  numerator of the section 7 coverage ratios. */
export function namedCount(outcomes: readonly NamePassOutcome[]): number {
  return outcomes.filter((o) => o.written).length;
}
