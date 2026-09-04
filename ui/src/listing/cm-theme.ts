// ui/src/listing/cm-theme.ts — CodeMirror 6 dressed in the shell's tokens.
// Spec 20 §1.2 / spec 22 §3.4: a colour is named ONCE, in ui/themes/*.json.
// CodeMirror normally ships its own palette (`defaultHighlightStyle` is full
// of hex literals), so the editor gets an explicit theme and an explicit
// highlight style, and every value in both is a `var(--token)`. That is why
// `@lezer/highlight` is a direct dependency: without `tags` we could not
// define a token-only highlight style and would be stuck with CodeMirror's
// own colours, which the token gate exists to prevent.
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Chrome: background, gutters, selection, the active-line band. */
export const hbcEditorTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    fontSize: "var(--type-sm)",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono-stack)",
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "transparent" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
  // Fold gutter: no new colours, just kept narrow (default CodeMirror
  // padding runs wide) so it does not steal width from the line numbers.
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", paddingInline: "2px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--surface-2)",
  },
  // Bur 2: the listing is a viewer, so it must not paint a text caret. The
  // cursor layer is not even installed (CodeView drops `drawSelection`);
  // this rule and the transparent caret-color are belt and braces, and they
  // also cover the native caret if a future edit mode ever makes a block
  // editable. The vim preset's block cursor (`.cm-fat-cursor`) is a
  // different element and is deliberately left visible.
  ".cm-cursor, .cm-dropCursor": { display: "none" },
  // The token under the pointer, and every other occurrence of it — the
  // listing's selection (../listing/token.ts).
  ".hbc-token-selected": { backgroundColor: "var(--surface-2)", outline: "1px solid var(--border-focus)" },
  ".hbc-token-occurrence": { backgroundColor: "var(--surface-2)" },
  ".cm-searchMatch": { backgroundColor: "var(--surface-2)", outline: "1px solid var(--border-focus)" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--border-focus)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)" },
  ".cm-panels input, .cm-panels button": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
  // The line the current selection points at (see CodeView's decoration).
  ".hbc-selected-line": { backgroundColor: "var(--surface-2)" },
  ".cm-fat-cursor": { backgroundColor: "var(--accent)" },
  // Syntax palette classes (spec 20 §1.2): the disasm view has no lezer
  // parser (plain text), so ./disasm-highlight.ts marks ranges with these
  // classes directly instead of going through `HighlightStyle`. Same names,
  // same underlying `--syn-*` variables as `hbcHighlightStyle` below, so
  // source and disasm read as one palette.
  ".hbc-syn-comment": { color: "var(--syn-comment)", fontStyle: "italic" },
  ".hbc-syn-keyword": { color: "var(--syn-keyword)" },
  ".hbc-syn-string": { color: "var(--syn-string)" },
  ".hbc-syn-number": { color: "var(--syn-number)" },
  ".hbc-syn-function": { color: "var(--syn-function)" },
  ".hbc-syn-variable": { color: "var(--syn-variable)" },
  ".hbc-syn-operator": { color: "var(--syn-operator)" },
  ".hbc-syn-invalid": { color: "var(--syn-invalid)" },
}, { dark: true });

/** Syntax, in tokens only. Values come from whichever theme preset is
 *  loaded (`ui/themes/*.json` `syntax` group) — this file only names which
 *  lezer tag maps to which token, never a colour. */
export const hbcHighlightStyle: HighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName), t.className], color: "var(--syn-variable)" },
  { tag: [t.propertyName, t.variableName, t.attributeName], color: "var(--syn-variable)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "var(--syn-operator)" },
  { tag: [t.invalid], color: "var(--syn-invalid)" },
]);
