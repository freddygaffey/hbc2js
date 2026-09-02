// Naming overlay (Design D) — a non-destructive, versioned, queryable layer of
// names keyed to the compiled binary's own binding identities, rendered at emit
// time. docs/specs/rename-tool-DESIGN-D-overlay.md, docs/RENAME.md.
//
// v1: register locals (`{fn,reg}`). Env slots / function names are reserved in
// the id shape but deferred (docs/name-overlay-feasibility.md).

export { regId, bindingKey, parseKey, shortForm } from "./id.ts";
export type { BindingId, RegisterId, EnvId, FnId } from "./id.ts";
export { OverlayStore } from "./store.ts";
export type { NameRecord, NameMeta, NameQuery, SetResult, Confidence, Source, Gate } from "./store.ts";
export { gateForFrame, frameHasRegister } from "./gate.ts";
export type { GateResult, GateRefusal } from "./gate.ts";
export { rawFrameBodies } from "./frames.ts";
export { render } from "./render.ts";
export type { RenderResult, RenderOptions, CollisionFlag } from "./render.ts";
export { NameService } from "./service.ts";
export type { SetNameInput, SetOutcome } from "./service.ts";
