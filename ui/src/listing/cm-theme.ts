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
    fontSize: "calc(var(--font-size, 14px) - 1px)",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono-stack)",
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--surface-2)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-selectionMatch": { backgroundColor: "var(--surface-2)" },
  ".cm-searchMatch": { backgroundColor: "var(--surface-2)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)" },
  ".cm-panels input, .cm-panels button": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
  // The line the current selection points at (see CodeView's decoration).
  ".hbc-selected-line": { backgroundColor: "var(--surface-2)" },
  ".cm-fat-cursor": { backgroundColor: "var(--accent)" },
}, { dark: true });

/** Syntax, in tokens only. Placeholder art direction exactly like the rest
 *  of the shell (docs/UI.md): the *structure* is the deliverable, the
 *  values come from whichever theme preset is loaded. */
export const hbcHighlightStyle: HighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--sev-ok)" },
  { tag: [t.number, t.bool, t.null], color: "var(--sev-med)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--text)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName), t.className], color: "var(--text)" },
  { tag: [t.propertyName, t.variableName, t.attributeName], color: "var(--text)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "var(--text-muted)" },
  { tag: [t.invalid], color: "var(--sev-crit)" },
]);
