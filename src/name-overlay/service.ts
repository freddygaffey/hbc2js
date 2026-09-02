// Resident naming service — docs/specs/rename-tool-DESIGN-D-overlay.md §5. The
// primary form the LLM loop imports: the bytecode is parsed once, the raw frame
// bodies and the overlay stay warm, and successive `setName` calls run the gate
// and record a name with no re-parse and no `.js` round-trip. The store is the
// source of truth; the analysis is only consulted for the gate and for `render`.

import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import { rawFrameBodies } from "./frames.ts";
import { gateForFrame } from "./gate.ts";
import type { GateRefusal } from "./gate.ts";
import type { BindingId } from "./id.ts";
import { OverlayStore } from "./store.ts";
import type { Confidence, NameRecord, NameQuery, SetResult, Source } from "./store.ts";
import { render } from "./render.ts";
import type { RenderOptions, RenderResult } from "./render.ts";

export interface SetNameInput {
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly source: Source;
  /** Force a name past a genuine (overridable) gate refusal — stamps
   *  `gate:"overridden"` + forces `confidence:"low"` (spec §6). */
  readonly override?: boolean;
  readonly ts?: string;
}

export type SetOutcome =
  | { readonly ok: true; readonly result: SetResult }
  | { readonly ok: false; readonly reason: GateRefusal; readonly overridable: boolean };

export class NameService {
  readonly store: OverlayStore;
  private readonly analysis: ModuleAnalysis;
  private readonly passes: PassPipelineOptions | undefined;
  private readonly strictEnv: boolean;
  private frames: Map<number, readonly Stmt[]> | null = null;

  constructor(analysis: ModuleAnalysis, store: OverlayStore, opts: { readonly passes?: PassPipelineOptions; readonly strictEnv?: boolean } = {}) {
    this.analysis = analysis;
    this.store = store;
    this.passes = opts.passes;
    this.strictEnv = opts.strictEnv ?? true;
  }

  /** Raw `rN` frame bodies, built once and kept warm (spec §5 resident mode). */
  private rawFrames(): Map<number, readonly Stmt[]> {
    if (this.frames === null) this.frames = rawFrameBodies(this.analysis, { ...(this.passes !== undefined ? { passes: this.passes } : {}), strictEnv: this.strictEnv });
    return this.frames;
  }

  /** Assign a name: gate it, then record it (spec §5/§6). A refused, non-forced
   *  name is NOT stored — the caller sees the gate's reason. */
  setName(id: BindingId, name: string, input: SetNameInput): SetOutcome {
    const body = id.kind === "reg" ? this.rawFrames().get(id.fn) : undefined;
    const verdict = gateForFrame(body, id, name, input.override === true);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, overridable: verdict.overridable };
    const overridden = verdict.gate === "overridden";
    const result = this.store.setName(id, name, {
      confidence: overridden ? "low" : input.confidence, // spec §6: an override is forced low
      evidence: input.evidence,
      source: input.source,
      gate: verdict.gate,
      ...(input.ts !== undefined ? { ts: input.ts } : {}),
    });
    return { ok: true, result };
  }

  getName(id: BindingId): NameRecord | null {
    return this.store.getName(id);
  }

  history(id: BindingId): readonly NameRecord[] {
    return this.store.history(id);
  }

  revert(id: BindingId, toTs?: string): NameRecord | null {
    return this.store.revert(id, toTs);
  }

  search(query: NameQuery): readonly NameRecord[] {
    return this.store.search(query);
  }

  render(opts: RenderOptions = {}): RenderResult {
    return render(this.analysis, this.store, { ...(this.passes !== undefined ? { passes: this.passes } : {}), strictEnv: this.strictEnv, ...opts });
  }
}
