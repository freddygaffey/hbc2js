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
import { runAdversarialRecheck } from "./evaluate.ts";
import type { AdversarialTarget } from "./evaluate.ts";

/** One REGISTER the loop should propose a name for -- landing 1's original
 *  shape, one backend call per `{fn,reg}`. `context` is the full
 *  `get_context`-shaped payload the backend prompts with (spec 28 section
 *  9.1's table); `context.source` doubles as the cache key's `body` (spec 28
 *  section 9.3). Callers build this from whatever they already have warm --
 *  the CLI from a freshly parsed bundle, the runner from `McpResources` --
 *  so gather stays outside this shared core. Still used by the UI's
 *  single-register job and by `--per-register` on the batch CLI/recorder;
 *  the batch default is `NamePassFunctionTarget` below. */
export interface NamePassRegisterTarget {
  readonly bindingId: BindingId;
  readonly kind: Extract<JobKind, "suggest-name" | "name-module">;
  readonly context: Record<string, unknown>;
  /** spec 28 section 1b step 8 (landing 5): flags this target for the
   *  adversarial re-check when `opts.adversarial` is wired. Absent means
   *  "not known to be security-relevant" -- the recheck still runs on it
   *  when it lands `high` confidence with `reach` above the threshold
   *  (`evaluate.ts`'s `needsAdversarialRecheck`). */
  readonly securityRelevant?: boolean;
  readonly reach?: number;
}

/** One FUNCTION's worth of unnamed registers, asked about in ONE backend
 *  call (spec 28 section 9.1's "one model call per function, not per
 *  register"). `context` carries the function's scoped source
 *  (`context.source`, never a whole-module render -- BUGS 2026-09-11 "render()
 *  is O(whole-bundle) per call") and `context.targets`, the skill's
 *  `{fn,reg}` short form for every register in `regs`, so the model can
 *  answer several bindings in the one `names[]` array its output contract
 *  already allows. `securityRelevant`/`reach` apply to the whole function's
 *  batch, same as the register form. */
export interface NamePassFunctionTarget {
  readonly kind: "suggest-name";
  readonly fn: number;
  readonly regs: readonly BindingId[];
  readonly context: Record<string, unknown>;
  readonly securityRelevant?: boolean;
  readonly reach?: number;
}

/** A target the per-target loop can process: one register (one call) or one
 *  function's whole batch of registers (one call, many names). */
export type NamePassTarget = NamePassRegisterTarget | NamePassFunctionTarget;

/** True for the function-batch form (`regs` is the discriminant -- a
 *  register target never has it). */
export function isFunctionTarget(target: NamePassTarget): target is NamePassFunctionTarget {
  return "regs" in target;
}

/** Build the per-register target an outcome from a function batch is
 *  reported against, so `NamePassOutcome.target` is always a
 *  `NamePassRegisterTarget` regardless of which call produced it -- every
 *  existing consumer (the adversarial re-check, `bindingKey(o.target.
 *  bindingId)`, callers reading `outcomes`) keeps working unchanged. */
function registerTargetFor(target: NamePassFunctionTarget, bindingId: BindingId): NamePassRegisterTarget {
  return {
    bindingId,
    kind: target.kind,
    context: target.context,
    ...(target.securityRelevant !== undefined ? { securityRelevant: target.securityRelevant } : {}),
    ...(target.reach !== undefined ? { reach: target.reach } : {}),
  };
}

export type NamePassSkipReason =
  | "backend-error"
  | "parse-error"
  | "abstained"
  | "gate-refused"
  | "budget-stopped"
  | "equiv-backstop-failed";

export interface NamePassOutcome {
  /** Always a REGISTER target, even when the call that produced it was a
   *  function batch (`registerTargetFor` synthesises one per requested
   *  `{fn,reg}`) -- one outcome is always about one binding. */
  readonly target: NamePassRegisterTarget;
  readonly proposal?: NameProposal;
  readonly written: boolean;
  readonly reason?: NamePassSkipReason;
  readonly detail?: string;
  /** True when the landing-5 adversarial re-check demoted this proposal
   *  (`misleading` verdict -> confidence forced to `low`, evidence prefixed
   *  `[flagged: misleading]`). Absent/false for everything the recheck did
   *  not touch, including targets it never ran on. */
  readonly flagged?: boolean;
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
  /** spec 28 section 1b step 8 (landing 5), "runs inside the naming pass when
   *  `evaluate` is `agent`": when wired, every WRITTEN high-value proposal
   *  (`securityRelevant`, or `high` confidence with `reach` above the
   *  threshold) gets one more backend call before the batch equiv backstop
   *  runs. A `misleading` verdict demotes the name in the overlay itself (a
   *  second `setName` call, its own supersession record) and is reflected in
   *  the outcome (`flagged: true`). Absent means no recheck runs -- the
   *  caller decides whether `evaluate` selected `agent` (section 9.6). */
  readonly adversarial?: { readonly backend: WorkerBackend; readonly signal?: AbortSignal };
  /** Called once per target, BEFORE its backend call, so a long batch run
   *  (a real bundle over `--backend claude-cli`, one call per target) has
   *  visible progress instead of going silent until the final summary --
   *  Fred 2026-09-13, found while a killed `name llm-fill --only src` run
   *  against the held-out bundle printed nothing at all past the initial
   *  module-selection line. Never throws into the loop: a caller's print
   *  callback misbehaving must not abort the pass. */
  readonly onProgress?: (progress: NamePassProgress) => void;
}

/** One target's position in a `runNamePass` run -- everything a progress
 *  printer needs, without recomputing anything the loop already knows. */
export interface NamePassProgress {
  readonly index: number;
  readonly total: number;
  readonly target: NamePassTarget;
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
  /** Count of `names[]` entries a function-batch reply returned whose
   *  `bindingId` was not one of that function's requested `regs` (an
   *  unrequested or unrecognised binding) -- dropped rather than written,
   *  and counted here so a caller can see a chatty/off-target reply without
   *  it silently vanishing. Always 0 for a run over register targets only. */
  readonly droppedUnknownNames: number;
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
  let droppedUnknownNames = 0;

  // Gate + write one proposal against one register target, recording the
  // outcome (`written`/`outcomes`) exactly the way the pre-batch code did --
  // shared by both the register loop and the function-batch loop below so
  // there is one write path, not two.
  const applyProposal = (regTarget: NamePassRegisterTarget, proposal: NameProposal): void => {
    const set = opts.service.setName(regTarget.bindingId, proposal.name, {
      confidence: proposal.confidence,
      evidence: proposal.evidence,
      source: "llm",
      ...(regTarget.securityRelevant !== undefined ? { securityRelevant: regTarget.securityRelevant } : {}),
    });
    if (!set.ok) {
      outcomes.push({ target: regTarget, proposal, written: false, reason: "gate-refused", detail: set.reason });
      return;
    }
    written.push({ id: regTarget.bindingId, ts: set.result.record.ts });
    outcomes.push({ target: regTarget, proposal, written: true });
  };

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex]!;
    try {
      opts.onProgress?.({ index: targetIndex, total: targets.length, target });
    } catch {
      // A progress printer's own failure must never abort the pass.
    }
    if (isFunctionTarget(target)) {
      // ONE backend call for the whole function's unnamed registers (spec 28
      // section 9.1: "one model call per function, not per register").
      if (opts.budgetTokens !== undefined && tokensUsed >= opts.budgetTokens) {
        stoppedAtBudget = true;
        for (const bid of target.regs) outcomes.push({ target: registerTargetFor(target, bid), written: false, reason: "budget-stopped" });
        continue;
      }

      const req: WorkerJobRequest = { kind: target.kind, prompt: "", context: target.context };
      let text: string;
      try {
        const res = await opts.backend.run(req, opts.signal);
        text = res.text;
        tokensUsed += (res.cost?.tokensIn ?? 0) + (res.cost?.tokensOut ?? 0);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        for (const bid of target.regs) outcomes.push({ target: registerTargetFor(target, bid), written: false, reason: "backend-error", detail });
        continue;
      }

      const parsed = parseReadabilityResult(text);
      if (!parsed.ok) {
        for (const bid of target.regs) outcomes.push({ target: registerTargetFor(target, bid), written: false, reason: "parse-error", detail: parsed.error });
        continue;
      }

      // Match `names[]` to the requested regs by bindingId. A name whose
      // bindingId is not one of `target.regs` is dropped and counted, never
      // written -- it did not survive the bounded-domain check because it
      // was never in-domain for this call. A reg with no matching name in
      // the reply is an abstain for that reg, same as an empty `names[]`
      // would be in the register form.
      const requested = new Map(target.regs.map((bid) => [bindingKey(bid), bid] as const));
      const byKey = new Map<string, NameProposal>();
      for (const n of parsed.result.names) {
        const k = bindingKey(n.bindingId);
        if (!requested.has(k)) {
          droppedUnknownNames += 1;
          continue;
        }
        byKey.set(k, n); // last entry for a duplicated bindingId wins
      }
      for (const bid of target.regs) {
        const proposal = byKey.get(bindingKey(bid));
        if (proposal === undefined) {
          outcomes.push({ target: registerTargetFor(target, bid), written: false, reason: "abstained" });
          continue;
        }
        applyProposal(registerTargetFor(target, bid), proposal);
      }
      continue;
    }

    // Register form: unchanged, one call per `{fn,reg}`.
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

    applyProposal(target, proposal);
  }

  // The landing-5 adversarial re-check (section 1b step 8), BEFORE the batch
  // backstop so a demotion is what the backstop proves stable, not the
  // pre-recheck name. Runs only over targets this run actually wrote.
  if (opts.adversarial !== undefined) {
    const indexByTargetId = new Map<string, number>();
    const adversarialTargets: AdversarialTarget[] = [];
    outcomes.forEach((o, i) => {
      if (!o.written || o.proposal === undefined) return;
      const targetId = bindingKey(o.target.bindingId);
      indexByTargetId.set(targetId, i);
      adversarialTargets.push({
        targetId,
        proposedName: o.proposal.name,
        confidence: o.proposal.confidence,
        evidence: o.proposal.evidence,
        securityRelevant: o.target.securityRelevant ?? false,
        ...(o.target.reach !== undefined ? { reach: o.target.reach } : {}),
      });
    });
    const verdicts = await runAdversarialRecheck(adversarialTargets, opts.adversarial.backend, opts.adversarial.signal ?? opts.signal);
    for (const v of verdicts) {
      if (!v.misleading) continue;
      const idx = indexByTargetId.get(v.targetId);
      const outcome = idx !== undefined ? outcomes[idx] : undefined;
      if (outcome === undefined || outcome.proposal === undefined) continue;
      const flaggedEvidence = `[flagged: misleading] ${v.rationale} (was: ${outcome.proposal.evidence})`;
      // `demote` patches the ACTIVE record IN PLACE (no new revision, no
      // chain growth, `OverlayStore.demote`'s own doc comment) -- this is a
      // same-pass correction to a write the batch backstop below already
      // tracks by `ts`, not a second reviewable transaction, so the single
      // `written` entry for this target stays valid.
      const patched = opts.service.store.demote(outcome.target.bindingId, { confidence: "low", evidence: flaggedEvidence });
      if (patched === null) continue;
      outcomes[idx as number] = {
        ...outcome,
        proposal: { ...outcome.proposal, confidence: "low", evidence: flaggedEvidence },
        flagged: true,
      };
    }
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

  return { outcomes, tokensUsed, stoppedAtBudget, equiv, droppedUnknownNames };
}

/** How many targets in `outcomes` actually got a name written -- the
 *  numerator of the section 7 coverage ratios. */
export function namedCount(outcomes: readonly NamePassOutcome[]): number {
  return outcomes.filter((o) => o.written).length;
}
