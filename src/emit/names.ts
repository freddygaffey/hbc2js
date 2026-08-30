// docs/specs/05-emitter.md §3 — names, and §5's string escaping. Fixed,
// deterministic, collision-free by construction. Never emit an identifier that is
// not declared: that is hermes-dec's defect 5 and risk R3.

/** Register n of the current frame. */
export const reg = (n: number): string => `r${n}`;
/** The top-level binding for function-table entry n. */
export const fnName = (n: number): string => `_fn${n}`;
/** A lexical environment slot. Declared in the env's owner function. */
export const envSlot = (env: number, slot: number): string => `_e${env}_${slot}`;
/** The catch binding of region n. */
export const excName = (n: number): string => `_exc${n}`;
/** A structurer label. */
export const labelName = (n: number): string => `L${n}`;
/** The §4.4 irreducible dispatch variable. */
export const stateVar = (n: number): string => `__state${n}`;

/** Per-function scratch and protocol variables (§7.2.1 and this implementation's
 *  §7.6 `__pc` guard). All start `__hbc` or `__` and cannot collide with a
 *  register, an env slot, a label or a function name. */
export const EXC_VALUE = "__exc";
export const PC_VAR = "__pc";
export const SCRATCH = "__t";
export const GEN_STATE = "__state";
export const GEN_SENT = "__sent";
export const GEN_IS_RETURN = "__isReturn";
export const GEN_DONE = "__done";

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * True when `text` may be emitted as `obj.text`. Reserved words must go through
 * the bracket path even though `obj.class` is legal ES5+ — keeping the rule
 * conservative means the output is valid under every parser we might feed it to.
 */
export function isSafePropertyName(text: string): boolean {
  return IDENT_RE.test(text) && !RESERVED.has(text);
}

/**
 * §5 — a double-quoted literal in pure ASCII: `\\`, `\"`, `\n`, `\r`, `\t`,
 * `\xNN` below 0x20, `\uNNNN` for everything >= 0x80 **including lone
 * surrogates**. The v94 corpus already contains a U+202F and a literal NUL
 * inside a regexp pattern; both must survive (EM-07).
 */
export function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x22) out += '\\"';
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else if (c >= 0x80) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  return out + '"';
}
