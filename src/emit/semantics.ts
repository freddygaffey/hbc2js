// docs/specs/05-emitter.md §8 — Hermes semantics, not spec semantics (D14).
//
// The decompiler reproduces what the *bytecode* does, not what the source meant.
// Where Hermes disagrees with ECMAScript (and with Node), the emitted JS must
// match Hermes. A "more correct" emission is a bug: if the output prints 0,1,2
// where the bytecode prints 3,3,3, the equivalence checker reports DIVERGENT and
// it is right to.
//
// docs/EQUIVALENCE.md §5.2 measured the divergences at 84 and 89;
// docs/AGENT-LOG.md's Hermes-VM-from-source entry confirmed all four unchanged
// at 94 and 99. The per-version table survives as *mechanism*, so that the day a
// version fixes one it is a one-line data change and not an archaeology
// exercise.

export interface VersionSemantics {
  /**
   * `for (let i …)` gets a fresh binding per iteration.
   * Hermes: **never** — the bytecode holds one environment slot for the loop
   * variable and every closure created in the body captures that same slot
   * (docs/lowering/closures-env-slots.md, executed at 84/94/99). The emitter
   * declares one variable per slot, which reproduces this by construction; the
   * flag exists so the choice is visible rather than accidental.
   */
  readonly perIterationLetBinding: boolean;
  /**
   * A `let`/`const` read before initialisation throws ReferenceError.
   * Hermes: only where the bytecode contains an explicit `ThrowIfEmpty`
   * (docs/lowering/tdz.md). The emitter never synthesises one.
   */
  readonly tdzOnShadowedLet: boolean;
  /**
   * Sloppy-mode `arguments` aliases the parameters.
   * Hermes: no aliasing at any version we target, so `__hbc_arguments` builds an
   * **unmapped** object.
   */
  readonly mappedArguments: boolean;
}

const HERMES_84_TO_99: VersionSemantics = {
  perIterationLetBinding: false,
  tdzOnShadowedLet: false,
  mappedArguments: false,
};

/** Measured at 84, 89, 94, 96, 98, 99 — identical throughout. */
const TABLE: Readonly<Record<number, VersionSemantics>> = {
  84: HERMES_84_TO_99,
  89: HERMES_84_TO_99,
  94: HERMES_84_TO_99,
  96: HERMES_84_TO_99,
  98: HERMES_84_TO_99,
  99: HERMES_84_TO_99,
};

export function semanticsFor(version: number): VersionSemantics {
  return TABLE[version] ?? HERMES_84_TO_99;
}

/**
 * How many registers at the top of a caller's frame are reserved for the
 * outgoing-call block, i.e. `arg[i]` lives in register `frameSize - N - i` with
 * `arg[0]` the `this` slot.
 *
 * Measured, not guessed: over every construct fixture, the highest register
 * written before a `Call`/`Construct` is `frameSize - 7` at v84/94/96 and
 * `frameSize - 8` at v98/99, and the first *real* argument of a `CallBuiltin`
 * (whose `this` slot the VM overwrites with `undefined`, so the compiler never
 * writes it) sits one below that. Cross-checked against
 * `44-tagged-templates` v94, where `getTemplateObject(0, false, 3 raw, 3 cooked)`
 * with argCount 9 and frameSize 24 lands exactly on r16..r9.
 */
export function argSlotBase(version: number, frameSize: number): number {
  return frameSize - (version >= 97 ? 8 : 7);
}
