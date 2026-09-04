// ui/src/listing/CodeView.tsx — the listing's editor: CodeMirror 6,
// read-only, token-themed (./cm-theme.ts), one instance per block (source
// and disasm). Spec 22 §3.2.
//
// Three things beyond "show text":
//   1. a decorated line, driven by the selection store, scrolled into view;
//   2. single-click on an identifier -> `select({kind:"identifier", name})`,
//      which is exactly what the context menu's Rename and the palette's
//      annotate actions consume (they read `ActionContext.selection`);
//   3. the vim layer, mounted only when `ui/keymap.json` says
//      `"preset": "vim"` (./../keymap-config.ts).
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView, lineNumbers, highlightActiveLineGutter, drawSelection,
  keymap as cmKeymap, Decoration, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { vim } from "@replit/codemirror-vim";
import { useEffect, useRef, type ReactNode } from "react";
import { hbcEditorTheme, hbcHighlightStyle } from "./cm-theme.ts";
import { vimEnabled } from "../keymap-config.ts";

// NOTE: this component installs NO `contextmenu` handler and stops no
// events. Right-clicking the listing must reach the document-level listener
// the annotate track's ContextMenu owns; a `preventDefault` here would take
// the menu away from it.

/** Set (or clear, with null) the decorated line. 1-based, like the gutter. */
const setLineHighlight = StateEffect.define<number | null>();

const lineHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setLineHighlight)) continue;
      const line = e.value;
      if (line === null || line < 1 || line > tr.state.doc.lines) next = Decoration.none;
      else next = Decoration.set([Decoration.line({ class: "hbc-selected-line" }).range(tr.state.doc.line(line).from)]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Set the function-start markers (1-based lines). */
const setMarks = StateEffect.define<readonly number[]>();

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      next = Decoration.set(
        e.value
          .filter((l) => l >= 1 && l <= tr.state.doc.lines)
          .sort((a, b) => a - b)
          .map((l) => Decoration.line({ class: "hbc-fn-start" }).range(tr.state.doc.line(l).from)),
      );
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface CodeViewProps {
  readonly text: string;
  /** `javascript` gets the JS parser; disasm is plain text. */
  readonly language: "javascript" | "plain";
  /** 1-based line to decorate and reveal, or null. */
  readonly highlightLine: number | null;
  /** Single click on a word. `line` is 1-based. */
  readonly onIdentifier?: (name: string, line: number) => void;
  /** Single click anywhere (fires with the line even when no word is hit). */
  readonly onLine?: (line: number) => void;
  /** 1-based lines that start a function, marked in the file view. */
  readonly markedLines?: readonly number[];
  readonly ariaLabel: string;
}

export function CodeView({ text, language, highlightLine, onIdentifier, onLine, markedLines, ariaLabel }: CodeViewProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Handlers live behind refs: the extension array is built once, but the
  // callbacks close over React state that changes every selection.
  const handlers = useRef<{ id?: CodeViewProps["onIdentifier"]; line?: CodeViewProps["onLine"] }>({});
  handlers.current = { ...(onIdentifier ? { id: onIdentifier } : {}), ...(onLine ? { line: onLine } : {}) };

  useEffect(() => {
    if (host.current === null) return undefined;
    const clicks = EditorView.domEventHandlers({
      click(event, v) {
        const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = v.state.doc.lineAt(pos).number;
        handlers.current.line?.(line);
        const word = v.state.wordAt(pos);
        if (word !== null) handlers.current.id?.(v.state.sliceDoc(word.from, word.to), line);
        return false;
      },
    });
    const extensions: Extension[] = [
      ...(vimEnabled ? [vim()] : []),
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      search({ top: true }),
      highlightSelectionMatches(),
      cmKeymap.of([...searchKeymap, ...defaultKeymap]),
      lineHighlightField,
      markField,
      syntaxHighlighting(hbcHighlightStyle),
      hbcEditorTheme,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, tabindex: "0" }),
      clicks,
      ...(language === "javascript" ? [javascript()] : []),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once per language/label; `text` is pushed in by
    // the effect below, so switching functions never remounts the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, ariaLabel]);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    if (v.state.doc.toString() !== text) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 } });
    }
  }, [text]);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    v.dispatch({ effects: setMarks.of(markedLines ?? []) });
  }, [markedLines, text]);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    const line = highlightLine !== null && highlightLine >= 1 && highlightLine <= v.state.doc.lines ? highlightLine : null;
    v.dispatch({
      effects: [
        setLineHighlight.of(line),
        ...(line === null ? [] : [EditorView.scrollIntoView(v.state.doc.line(line).from, { y: "center" })]),
      ],
    });
  }, [highlightLine, text]);

  return <div ref={host} className="hbc-scroll h-full min-h-0 w-full overflow-hidden" data-testid="code-view" />;
}
