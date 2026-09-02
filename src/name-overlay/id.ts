// Binding identity — docs/specs/rename-tool-DESIGN-D-overlay.md §3.
//
// Every nameable binding gets a stable, serialisable id derived from the
// compiled binary, identical across decompiler runs and independent of emitted
// text. v1 owns the register-local kind only; env-slot and function kinds are
// reserved in the shape (spec §8) but refused until closure-naming / fn-naming
// key into the overlay (docs/name-overlay-feasibility.md).

/** A register local: register `reg` of Hermes bytecode function `fn`. The
 *  only binding kind v1 applies names to. */
export interface RegisterId {
  readonly kind: "reg";
  readonly fn: number;
  readonly reg: number;
}

/** An environment slot (spec §8) — reserved; v1 stores but never renders one,
 *  since slot identity is closure-naming's model, which is not built yet. */
export interface EnvId {
  readonly kind: "env";
  readonly fn: number;
  readonly env: number;
}

/** A function (spec §8) — reserved for v1.1. */
export interface FnId {
  readonly kind: "fn";
  readonly fn: number;
}

export type BindingId = RegisterId | EnvId | FnId;

/** Construct a register-local id. */
export function regId(fn: number, reg: number): RegisterId {
  return { kind: "reg", fn, reg };
}

/** A stable, order-independent string key for a binding id — the map key the
 *  store groups a binding's history under, and what a caller can round-trip
 *  through `parseKey`. */
export function bindingKey(id: BindingId): string {
  switch (id.kind) {
    case "reg":
      return `reg:${id.fn}:${id.reg}`;
    case "env":
      return `env:${id.fn}:${id.env}`;
    case "fn":
      return `fn:${id.fn}`;
  }
}

/** Inverse of `bindingKey`. Throws on a malformed key. */
export function parseKey(key: string): BindingId {
  const parts = key.split(":");
  if (parts[0] === "reg" && parts.length === 3) return { kind: "reg", fn: Number(parts[1]), reg: Number(parts[2]) };
  if (parts[0] === "env" && parts.length === 3) return { kind: "env", fn: Number(parts[1]), env: Number(parts[2]) };
  if (parts[0] === "fn" && parts.length === 2) return { kind: "fn", fn: Number(parts[1]) };
  throw new Error(`malformed binding key: ${JSON.stringify(key)}`);
}

/** The `{fn,reg}` short form the spec's token-minimal output uses:
 *  `named {42,7} → …`. Register ids only. */
export function shortForm(id: RegisterId): string {
  return `{${id.fn},${id.reg}}`;
}
