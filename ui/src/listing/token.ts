// ui/src/listing/token.ts — what a "token" is in the listing (bur 2, bur 7;
// docs/UI.md "The listing").
//
// The listing is a VIEWER, not a text editor: the unit of selection is a
// whole token (an identifier, a property name, a literal, a keyword), the
// way it is in Ghidra/IDA, not a character offset. Everything in this file
// is pure and CodeMirror-free so the classification can be reasoned about
// (and unit-tested) without an editor: `CodeView.tsx` supplies the ranges,
// this module says what they ARE, and `CenterPane.tsx` decides what may be
// navigated to (bur 7: a keyword has no target, so a double-click on
// `function` must not navigate anywhere).
//
// Deliberately NOT a syntax analysis: `kindFromNodeName` maps the Lezer
// node names `@codemirror/lang-javascript` produces, and `classifyWord` is
// the fallback for the disassembly block (plain text, no parser) and for
// positions the incremental parser has not reached yet.

export type TokenKind =
  | "identifier"   // a variable/global read: `foo`
  | "definition"   // a binding site: `function foo`, `let foo`, `{ foo: … }`
  | "property"     // a member name: `x.foo`
  | "keyword"      // `function`, `return`, `true`, …
  | "string"
  | "number"
  | "comment"
  | "punctuation"; // anything else a range can land on

/** Reserved words (ES2024) plus the contextual ones a rename must not
 *  produce. `undefined`/`NaN`/`Infinity` are not reserved but renaming a
 *  binding to one of them is never what anybody meant, so they are refused
 *  too (see `validateIdentifierName`). */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

const NEVER_A_NAME: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity", "arguments", "eval"]);

/** JS identifier syntax, ASCII subset — which is all Hermes emits and all a
 *  rename is allowed to introduce. */
export const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** True for the characters a listing token is made of. `$` is included (CM's
 *  own word categoriser leaves it out, which would split `$foo` in two). */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** Classify a bare word with no parser to help: the fallback for the disasm
 *  block and for text the incremental parse has not covered. */
export function classifyWord(text: string): TokenKind {
  if (text === "") return "punctuation";
  if (RESERVED_WORDS.has(text)) return "keyword";
  if (/^[0-9]/.test(text)) return "number";
  if (IDENTIFIER_RE.test(text)) return "identifier";
  return "punctuation";
}

/** Lezer (`@codemirror/lang-javascript`) node name -> token kind. `null`
 *  when the name says nothing useful (a container node, or the plain-text
 *  block's empty tree), in which case the caller falls back to
 *  `classifyWord`. Keywords are NOT listed: lezer names a keyword node after
 *  its own text (`function`, `return`, …), which `classifyWord` already
 *  recognises through `RESERVED_WORDS`. */
export function kindFromNodeName(name: string): TokenKind | null {
  switch (name) {
    case "VariableName":
    case "LabelName":
    case "TypeName":
      return "identifier";
    case "VariableDefinition":
    case "PropertyDefinition":
    case "PropertyNameDefinition":
      return "definition";
    case "PropertyName":
    case "PrivatePropertyName":
      return "property";
    case "String":
    case "TemplateString":
    case "RegExp":
      return "string";
    case "Number":
    case "BigInt":
      return "number";
    case "LineComment":
    case "BlockComment":
    case "Comment":
      return "comment";
    default:
      return null;
  }
}

/** A token the listing has resolved under the pointer. `from`/`to` are
 *  document offsets; `line` is 1-based, like the gutter. */
export interface ListingToken {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly kind: TokenKind;
  readonly line: number;
}

/** Does this token name something? Identifiers, definitions and property
 *  names do; keywords, literals, comments and punctuation never do. This is
 *  the gate on BOTH the rename target and, with a resolved symbol, on
 *  double-click navigation. */
export function isNameLike(kind: TokenKind): boolean {
  return kind === "identifier" || kind === "definition" || kind === "property";
}

/** Bur 7: may a double-click on this token even TRY to navigate? A keyword
 *  (`function`), a literal or punctuation answers no before any lookup
 *  happens, so the pane can flash "no target" instead of navigating to a
 *  function that does not exist. A `true` here is still only a licence to
 *  look the name up — an unresolved identifier does not navigate either. */
export function isNavigable(token: ListingToken | null): boolean {
  return token !== null && isNameLike(token.kind) && !RESERVED_WORDS.has(token.text) && IDENTIFIER_RE.test(token.text);
}

/** Validate a name typed in an edit mode (rename). Returns the reason it is
 *  refused, or `null` when it is acceptable. Bur 2: text entry in the
 *  listing only ever happens behind an explicit edit mode, and that mode
 *  syntax-checks before it commits. */
export function validateIdentifierName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "a name is required";
  if (!IDENTIFIER_RE.test(trimmed)) return `"${trimmed}" is not a JavaScript identifier (letters, digits, _ and $; not starting with a digit)`;
  if (RESERVED_WORDS.has(trimmed)) return `"${trimmed}" is a reserved word`;
  if (NEVER_A_NAME.has(trimmed)) return `"${trimmed}" is not usable as a name`;
  return null;
}

/** Every whole-word occurrence of `word` in `text`, as [from, to) offsets —
 *  the Ghidra-style "highlight the thing I clicked everywhere it appears".
 *  Capped (`limit`) and skipped entirely on very large documents by the
 *  caller; a plain scan, no regex construction from user text. */
export function wordOccurrences(text: string, word: string, limit = 500): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  if (!IDENTIFIER_RE.test(word)) return out;
  let at = text.indexOf(word);
  while (at !== -1 && out.length < limit) {
    const before = at === 0 ? undefined : text[at - 1];
    const after = text[at + word.length];
    if (!isWordChar(before) && !isWordChar(after)) out.push([at, at + word.length] as const);
    at = text.indexOf(word, at + word.length);
  }
  return out;
}
