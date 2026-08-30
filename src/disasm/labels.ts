// docs/specs/02-disassembler.md §5 — deterministic, mode-independent labels.
import type { ExceptionHandler } from "../parse/types.ts";
import type { Instruction } from "./decode.ts";

/**
 * L-namespace labels: the target set is every instruction target (jump/
 * condJump's single target; switch's default + cases, per Instruction.targets)
 * union every handler *target* (a catch entry is a jump destination too),
 * sorted ascending, numbered L1, L2, … `L0` is deliberately unused so a bare
 * `L` never collides with a register name in a normaliser regex (spec 02 §5).
 */
export function assignLabels(instructions: readonly Instruction[], handlers: readonly ExceptionHandler[]): ReadonlyMap<number, string> {
  const targets = new Set<number>();
  for (const insn of instructions) {
    for (const t of insn.targets) targets.add(t);
  }
  for (const h of handlers) targets.add(h.target);
  const sorted = [...targets].sort((a, b) => a - b);
  const labels = new Map<number, string>();
  sorted.forEach((offset, i) => labels.set(offset, `L${i + 1}`));
  return labels;
}

/**
 * T-namespace labels: handler `start`/`end` (protected-region boundary)
 * offsets, sorted ascending, numbered T1, T2, … A separate namespace so
 * exception-region annotations never perturb L numbering when a handler range
 * boundary happens not to also be a jump target (spec 02 §5 step 4). Not part
 * of `DecodedFunction` — printers derive it on demand from `fn.handlers`,
 * since it is cheap and deterministic.
 */
export function assignHandlerLabels(handlers: readonly ExceptionHandler[]): ReadonlyMap<number, string> {
  const offsets = new Set<number>();
  for (const h of handlers) {
    offsets.add(h.start);
    offsets.add(h.end);
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  const labels = new Map<number, string>();
  sorted.forEach((offset, i) => labels.set(offset, `T${i + 1}`));
  return labels;
}
