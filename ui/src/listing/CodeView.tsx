// ui/src/listing/CodeView.tsx — the listing's editor: CodeMirror 6,
// read-only, caret-less, token-themed (./cm-theme.ts), one instance per
// block (source and disasm). Spec 22 §3.2; burs 2 and 7.
//
// Four things beyond "show text":
//   1. a decorated line, driven by the selection store, scrolled into view;
//   2. NO text caret and no character selection (bur 2): the pane is a
//      viewer. `EditorState.readOnly` + `EditorView.editable(false)` were
//      always set, but `drawSelection()` still painted a blinking `|` as
//      soon as the content took focus, which says "type here" about a
//      listing nothing can be typed into. The cursor layer is gone and
//      `.cm-cursor` is hidden in the theme; text is still selectable and
//      copyable through the browser's own selection.
//   3. the unit of selection is a TOKEN, not a character offset (bur 2):
//      one click resolves the whole word under the pointer (./token.ts),
//      decorates it and every other occurrence of it, exposes it on the
//      host element as `data-selected-token[-kind]`, and reports it to the
//      pane, which turns it into `select({kind:"identifier", …})` — exactly
//      what the context menu's Rename and the palette's annotate actions
//      consume (they read `ActionContext.selection`);
//   4. bur 15 (docs/UI-BURS.md #15): double-click opens the rename dialog
//      for the token (never navigates); TRIPLE-click ACTIVATES it — go to
//      what it names (bur 7's gate: a keyword, a literal or punctuation
//      must never navigate). This component only resolves and reports the
//      token; whether it names anything renameable/navigable is the pane's
//      call (`CenterPane`), because only the pane has the symbol map. The
//      native `dblclick` event fires before a third click can, so a
//      genuine dblclick's rename is DEFERRED `RENAME_DEBOUNCE_MS` and
//      cancelled if a `click` with `detail === 3` arrives in time.
//
// The vim layer is mounted only when `ui/keymap.json` says
// `"preset": "vim"` (./../keymap-config.ts); its block cursor is
// `.cm-fat-cursor` and is left alone — bur 2 is about the text caret.
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView, lineNumbers, highlightActiveLineGutter,
  keymap as cmKeymap, Decoration, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { codeFolding, foldGutter, foldKeymap, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { vim } from "@replit/codemirror-vim";
import { useEffect, useRef, type ReactNode } from "react";
import { hbcEditorTheme, hbcHighlightStyle } from "./cm-theme.ts";
import { disasmHighlight } from "./disasm-highlight.ts";
import { vimEnabled } from "../keymap-config.ts";
import { setActiveFoldView } from "./fold-store.ts";
import { setActiveListingNav } from "./listing-nav-store.ts";
import { classifyWord, isWordChar, kindFromNodeName, wordOccurrences, type ListingToken } from "./token.ts";

// NOTE: this component installs NO `contextmenu` handler and stops no
// events. Right-clicking the listing must reach the document-level listener
// the annotate track's ContextMenu owns; a `preventDefault` here would take
// the menu away from it.

/** Bur 15: how long a double-click's rename waits before firing, so a
 *  third click (triple-click = activate/navigate, not rename) can cancel
 *  it. Comfortably above the gap between synthetic clicks (Playwright's
 *  `click({clickCount:3})`/`dblclick()`) and well under a real double
 *  click's own multi-click window, so neither a genuine double-click nor a
 *  genuine triple-click is ever mistaken for the other. */
const RENAME_DEBOUNCE_MS = 250;

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

/** Documents bigger than this do not get the "every other occurrence"
 *  highlight — one click would otherwise scan megabytes of module source.
 *  The clicked token itself is always decorated. */
const OCCURRENCE_SCAN_LIMIT = 400_000;

const selectedMark = Decoration.mark({ class: "hbc-token-selected" });
const occurrenceMark = Decoration.mark({ class: "hbc-token-occurrence" });

/** Set (or clear, with null) the selected token. */
const setToken = StateEffect.define<{ readonly from: number; readonly to: number; readonly text: string } | null>();

const tokenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setToken)) continue;
      if (e.value === null) {
        next = Decoration.none;
        continue;
      }
      const { from, to, text } = e.value;
      const marks = [selectedMark.range(from, to)];
      const doc = tr.state.doc;
      if (doc.length <= OCCURRENCE_SCAN_LIMIT) {
        for (const [a, b] of wordOccurrences(doc.toString(), text)) {
          if (a !== from) marks.push(occurrenceMark.range(a, b));
        }
      }
      next = Decoration.set(marks, true);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** What the pointer is on: the whole token under it (`null` on whitespace
 *  or punctuation) plus the 1-based line, which is reported either way. */
export interface PointerHit {
  readonly token: ListingToken | null;
  readonly line: number;
}

/** Resolve the token AT a document position — the shared tail both a mouse
 *  hit (`pointerHit`, below) and a keyboard move (bur 13, ./listing-nav-
 *  store.ts) resolve through, so a `listing.lineDown`/`tokenRight` chord
 *  finds exactly the token a click at that spot would have found: same word
 *  boundaries, same syntax-tree `kind` lookup, same fallback. */
export function hitAtPos(v: EditorView, pos: number): PointerHit | null {
  const state = v.state;
  const docLine = state.doc.lineAt(pos);
  const text = docLine.text;
  let col = pos - docLine.from;
  // Landing just past the end of a word still means that word.
  if (!isWordChar(text[col]) && isWordChar(text[col - 1])) col -= 1;
  if (!isWordChar(text[col])) return { token: null, line: docLine.number };
  let from = col;
  let to = col;
  while (from > 0 && isWordChar(text[from - 1])) from -= 1;
  while (to < text.length && isWordChar(text[to])) to += 1;
  const word = text.slice(from, to);
  const absFrom = docLine.from + from;
  const nodeName = syntaxTree(state).resolveInner(absFrom, 1).name;
  const kind = kindFromNodeName(nodeName) ?? classifyWord(word);
  return { token: { from: absFrom, to: docLine.from + to, text: word, kind, line: docLine.number }, line: docLine.number };
}

/** Resolve the token under a mouse event. Word boundaries come from the
 *  document text (so `$foo` stays one token, unlike CodeMirror's own word
 *  categoriser); the KIND comes from the syntax tree when there is one —
 *  that is what tells a `PropertyName` from a `String` from the keyword
 *  `function` — and falls back to `classifyWord` for the plain-text disasm
 *  block and for text the incremental parser has not reached. */
export function pointerHit(v: EditorView, x: number, y: number): PointerHit | null {
  const pos = v.posAtCoords({ x, y });
  if (pos === null) return null;
  return hitAtPos(v, pos);
}

/** Every word token on one line, as absolute `[from, to)` doc offsets, in
 *  left-to-right order. Bur 13's `Left`/`Right` step between these. */
export function tokensOnLine(v: EditorView, lineNo: number): Array<{ readonly from: number; readonly to: number }> {
  const docLine = v.state.doc.line(lineNo);
  const text = docLine.text;
  const out: Array<{ from: number; to: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (!isWordChar(text[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && isWordChar(text[j])) j += 1;
    out.push({ from: docLine.from + i, to: docLine.from + j });
    i = j;
  }
  return out;
}

export interface CodeViewProps {
  readonly text: string;
  /** `javascript` gets the JS parser + `hbcHighlightStyle`; `disasm` is
   *  plain text with the line-based classifier (./disasm-highlight.ts);
   *  `plain` is unstyled plain text. */
  readonly language: "javascript" | "disasm" | "plain";
  /** 1-based line to decorate and reveal, or null. */
  readonly highlightLine: number | null;
  /** Single click: the token under the pointer (null on punctuation or
   *  whitespace) and the 1-based line it is on. */
  readonly onSelectToken?: (token: ListingToken | null, line: number) => void;
  /** Triple click (bur 15): "go to this". The pane decides whether the
   *  token names anything (bur 7) — this component never navigates. */
  readonly onActivateToken?: (token: ListingToken | null, line: number) => void;
  /** Double click (bur 15): open the rename dialog for this token. The
   *  pane decides whether the token is renameable at all — this component
   *  never opens anything itself, and never fires this when a third click
   *  arrived in time to make it a triple click instead. */
  readonly onRenameToken?: (token: ListingToken | null, line: number) => void;
  /** 1-based lines that start a function, marked in the file view. */
  readonly markedLines?: readonly number[];
  readonly ariaLabel: string;
  /** When true, this instance becomes the target of `view.fold` /
   *  `view.unfold` (../actions/registry.ts) while it is mounted — the
   *  listing's primary block, never the disasm block (./fold-store.ts). */
  readonly registerFold?: boolean;
}

export function CodeView({
  text, language, highlightLine, onSelectToken, onActivateToken, onRenameToken, markedLines, ariaLabel, registerFold,
}: CodeViewProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Handlers live behind refs: the extension array is built once, but the
  // callbacks close over React state that changes every selection.
  const handlers = useRef<{
    select?: CodeViewProps["onSelectToken"]; activate?: CodeViewProps["onActivateToken"];
    rename?: CodeViewProps["onRenameToken"];
  }>({});
  handlers.current = {
    ...(onSelectToken ? { select: onSelectToken } : {}),
    ...(onActivateToken ? { activate: onActivateToken } : {}),
    ...(onRenameToken ? { rename: onRenameToken } : {}),
  };

  useEffect(() => {
    if (host.current === null) return undefined;
    const hostEl = host.current;
    const show = (v: EditorView, hit: PointerHit | null): void => {
      const token = hit?.token ?? null;
      v.dispatch({ effects: setToken.of(token === null ? null : { from: token.from, to: token.to, text: token.text }) });
      if (token === null) {
        hostEl.removeAttribute("data-selected-token");
        hostEl.removeAttribute("data-selected-token-kind");
      } else {
        hostEl.setAttribute("data-selected-token", token.text);
        hostEl.setAttribute("data-selected-token-kind", token.kind);
      }
      if (hit !== null) hostEl.setAttribute("data-selected-line", String(hit.line));
    };
    // Bur 15: the third click of a triple-click still fires `dblclick`
    // first (the DOM fires `click`(detail 2), then `dblclick`, then
    // `click`(detail 3) — never a second `dblclick`), so a genuine
    // double-click's rename is scheduled here and cancelled by `click`'s
    // `detail === 3` branch below if a third click follows in time.
    let renameTimer: ReturnType<typeof setTimeout> | null = null;
    const pointer = EditorView.domEventHandlers({
      click(event, v) {
        if (event.detail === 3) {
          if (renameTimer !== null) {
            clearTimeout(renameTimer);
            renameTimer = null;
          }
          const hit = pointerHit(v, event.clientX, event.clientY);
          if (hit === null) return false;
          show(v, hit);
          handlers.current.activate?.(hit.token, hit.line);
          return false;
        }
        // The second click of a double-click arrives here too (detail 2);
        // it selects the same token, so let `dblclick` handle it alone.
        if (event.detail > 1) return false;
        const hit = pointerHit(v, event.clientX, event.clientY);
        if (hit === null) return false;
        show(v, hit);
        handlers.current.select?.(hit.token, hit.line);
        return false;
      },
      dblclick(event, v) {
        const hit = pointerHit(v, event.clientX, event.clientY);
        if (hit === null) return false;
        show(v, hit);
        if (renameTimer !== null) clearTimeout(renameTimer);
        renameTimer = setTimeout(() => {
          renameTimer = null;
          handlers.current.rename?.(hit.token, hit.line);
        }, RENAME_DEBOUNCE_MS);
        return false;
      },
    });

    // Bur 13: the current keyboard-navigation position, resolved from the
    // SAME `data-selected-line`/`data-selected-token` attributes `show()`
    // writes on every click — no separate cursor state to drift out of sync
    // with what a click just set. Falls back to the top of the document
    // before anything has ever been selected.
    const currentPos = (v: EditorView): number => {
      const lineAttr = hostEl.getAttribute("data-selected-line");
      const lineNo = Math.min(Math.max(1, lineAttr === null ? 1 : Number(lineAttr) || 1), v.state.doc.lines);
      const docLine = v.state.doc.line(lineNo);
      const tokenAttr = hostEl.getAttribute("data-selected-token");
      if (tokenAttr !== null && tokenAttr !== "") {
        const idx = docLine.text.indexOf(tokenAttr);
        if (idx !== -1) return docLine.from + idx;
      }
      return docLine.from;
    };
    const applyHit = (v: EditorView, hit: PointerHit): void => {
      show(v, hit);
      handlers.current.select?.(hit.token, hit.line);
    };
    const moveLine = (v: EditorView, delta: number): boolean => {
      const pos = currentPos(v);
      const from = v.state.doc.lineAt(pos);
      const col = pos - from.from;
      const targetNo = Math.min(Math.max(1, from.number + delta), v.state.doc.lines);
      if (targetNo === from.number) return false;
      const target = v.state.doc.line(targetNo);
      const targetPos = Math.min(target.from + col, target.to);
      applyHit(v, hitAtPos(v, targetPos) ?? { token: null, line: targetNo });
      return true;
    };
    const moveToken = (v: EditorView, delta: number): boolean => {
      const pos = currentPos(v);
      const lineNo = v.state.doc.lineAt(pos).number;
      const tokens = tokensOnLine(v, lineNo);
      if (tokens.length === 0) return false;
      let idx = tokens.findIndex((t) => pos >= t.from && pos <= t.to);
      if (idx === -1) idx = tokens.findIndex((t) => t.from >= pos);
      if (idx === -1) idx = tokens.length - 1;
      const nextIdx = Math.min(Math.max(0, idx + delta), tokens.length - 1);
      if (nextIdx === idx) return false;
      const hit = hitAtPos(v, tokens[nextIdx]!.from);
      if (hit === null) return false;
      applyHit(v, hit);
      return true;
    };
    const extensions: Extension[] = [
      ...(vimEnabled ? [vim()] : []),
      lineNumbers(),
      highlightActiveLineGutter(),
      search({ top: true }),
      codeFolding(),
      foldGutter(),
      cmKeymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
      lineHighlightField,
      markField,
      tokenField,
      syntaxHighlighting(hbcHighlightStyle),
      hbcEditorTheme,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, tabindex: "0" }),
      pointer,
      ...(language === "javascript" ? [javascript()] : []),
      ...(language === "disasm" ? [disasmHighlight] : []),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: hostEl });
    view.current = v;
    if (registerFold) {
      setActiveFoldView(v);
      setActiveListingNav({ moveLine: (delta) => moveLine(v, delta), moveToken: (delta) => moveToken(v, delta) });
    }
    return () => {
      if (renameTimer !== null) clearTimeout(renameTimer);
      v.destroy();
      view.current = null;
      if (registerFold) {
        setActiveFoldView(null);
        setActiveListingNav(null);
      }
    };
    // The editor is created once per language/label; `text` is pushed in by
    // the effect below, so switching functions never remounts the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, ariaLabel]);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    if (v.state.doc.toString() !== text) {
      // A new document: the old token selection indexes text that is gone.
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 }, effects: setToken.of(null) });
      host.current?.removeAttribute("data-selected-token");
      host.current?.removeAttribute("data-selected-token-kind");
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
    // Bur 13: `data-selected-line` is the single source of truth keyboard
    // navigation (`currentPos`, above) resumes from — previously only a
    // literal click in the editor set it, so landing here from anywhere
    // else (graph double-click, xrefs, search) left arrow-key navigation
    // starting from line 1 instead of where the analyst just arrived.
    if (line !== null) host.current?.setAttribute("data-selected-line", String(line));
  }, [highlightLine, text]);

  return <div ref={host} data-readonly="true" className="hbc-scroll h-full min-h-0 w-full overflow-hidden" data-testid="code-view" />;
}
