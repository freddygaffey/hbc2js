// docs/specs/05-emitter.md §16 — bytecode origin of an emitted statement.
//
// The map exists so a reader looking at a line of decompiled JS can be shown
// the instruction it came from (`GET /api/fn/:fn/linemap`, the UI's
// source<->disasm alignment). Its one hard rule is the artifact truth rule
// (docs/specs/10-artifact-format.md §0): a mapped line must point at an
// instruction that really contributed to it. Coverage is therefore partial by
// design — a statement synthesised by a later pass, or one built from several
// blocks, carries no origin rather than a plausible-looking guess.
import type { Instruction } from "../disasm/decode.ts";
import type { Origin, Stmt } from "./ast.ts";

export type { Origin };

/** The half-open byte range `[offset, offset + length)` of one instruction of
 *  function `fn` — `start` is exactly the number `src/disasm/print.ts` prints
 *  as `[@ N]` in `fn`'s own listing, so the UI can find the line by string
 *  match once it has checked `fn`. */
export function originOfInsn(fn: number, insn: Instruction): Origin {
  return { fn, start: insn.offset, end: insn.offset + insn.length };
}

/** The origin recorded on a statement, if any. Reading goes through this
 *  helper (never `s.origin` directly) so the carrier can change without
 *  touching every call site. */
export function originOf(s: Stmt): Origin | undefined {
  return (s as { readonly origin?: Origin }).origin;
}

/** `s` with `o` recorded on it. Never overwrites an origin already there (the
 *  innermost/earliest stamp wins — it is the one that saw the instruction).
 *  Statement kinds outside the union's origin-bearing set are returned
 *  untouched, so a caller may stamp a whole `out` slice blindly. */
export function withOrigin<S extends Stmt>(s: S, o: Origin | undefined): S {
  if (o === undefined || originOf(s) !== undefined) return s;
  switch (s.k) {
    case "expr":
    case "decl":
    case "init":
    case "if":
    case "while":
    case "do-while":
    case "for":
    case "break":
    case "continue":
    case "return":
    case "throw":
    case "switch":
      return { ...s, origin: o } as S;
    default:
      return s;
  }
}

/** Stamp every statement `out[from…]` in place — the shape `lowerInstruction`
 *  needs, since it appends an unknown number of statements per instruction. */
export function stampFrom(out: Stmt[], from: number, o: Origin | undefined): void {
  if (o === undefined) return;
  for (let i = from; i < out.length; i++) out[i] = withOrigin(out[i]!, o);
}

/** One row of `GET /api/fn/:fn/linemap`: `[line, fn, start, end]` — a 1-based
 *  line of the rendered text, and the instruction behind it as a function index
 *  plus a half-open byte range within THAT function. `fn` is usually the
 *  function being rendered but not always: a nested closure printed inside its
 *  parent contributes rows carrying its own index (docs/specs/05-emitter.md
 *  §16). Tuple, not an object, because a large function produces one row per
 *  statement and this crosses the wire. */
export type LineMapEntry = readonly [line: number, fn: number, start: number, end: number];

/** Collect a whole function's rows in printed order, de-duplicated per line:
 *  a line is reported once, by the FIRST statement printed on it (a statement
 *  sharing a line with an earlier one — the `}` / `else` joins — would
 *  otherwise overwrite an earlier, equally true answer with a later one). */
export function lineMapCollector(): { readonly onStmtLine: (line: number, origin: Origin) => void; rows(): LineMapEntry[] } {
  const seen = new Map<number, Origin>();
  return {
    onStmtLine: (line, origin) => {
      if (!seen.has(line)) seen.set(line, origin);
    },
    rows: () => [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([line, o]) => [line, o.fn, o.start, o.end] as LineMapEntry),
  };
}
