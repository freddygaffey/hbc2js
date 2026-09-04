// ui/src/components/ContextMenu.tsx — spec 22 §3.3's context menu: Radix
// ContextMenu, items from `contextMenuFor(ctx, registry, keymap)` with the
// chord shown at the right. It holds NO list of its own — an action added to
// src/ui-core/actions.ts appears here for free.
//
// Why a document-level capture listener rather than wrapping panes in a
// Radix Trigger: the centre pane is CodeMirror and the left pane is the
// listing track's tree; neither file is ours to edit, and CodeMirror's own
// DOM swallowed the right-click, leaving the browser's native menu on the
// source text. So we listen on `document` in the CAPTURE phase, call
// `preventDefault()` for every right-click inside the app that is not in a
// real text field (where the native copy/paste menu is what you want),
// derive the selection at the click point, and then re-dispatch a synthetic
// `contextmenu` at the same coordinates onto a 1px anchor that IS a Radix
// trigger — so Radix still owns positioning, keyboard nav and focus return.
// Synthetic events are `isTrusted === false`, which is how the listener
// avoids re-entering itself.
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { contextMenuFor } from "@ui-core/actions.ts";
import { actionContext, keymap, registry, runAction } from "../actions/registry.ts";
import { select, useSelection } from "../state/selection.ts";

/** Right-clicks inside these keep the browser's own menu. */
const NATIVE_MENU = 'input, textarea, select, [contenteditable="true"]';

const WORD_CHAR = /[A-Za-z0-9_$]/;

/** The identifier under the pointer, via the caret APIs — no CodeMirror
 *  instance needed (the listing track exports none), so this works over the
 *  editor, the tree and any other text in the shell alike. */
export function wordAtPoint(x: number, y: number): string | undefined {
  const d = document as Document & {
    caretPositionFromPoint?: (cx: number, cy: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof d.caretPositionFromPoint === "function") {
    const pos = d.caretPositionFromPoint(x, y);
    if (pos !== null) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (typeof d.caretRangeFromPoint === "function") {
    const range = d.caretRangeFromPoint(x, y);
    if (range !== null) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (node === null || node.nodeType !== Node.TEXT_NODE) return undefined;
  const text = node.textContent ?? "";
  if (text === "") return undefined;
  let from = Math.min(offset, text.length);
  let to = from;
  while (from > 0 && WORD_CHAR.test(text[from - 1]!)) from -= 1;
  while (to < text.length && WORD_CHAR.test(text[to]!)) to += 1;
  const word = text.slice(from, to);
  return word === "" ? undefined : word;
}

const itemClass =
  "flex h-7 cursor-pointer items-center gap-6 rounded-ui px-2 text-xs text-text outline-none " +
  "data-[highlighted]:bg-surface-2 data-[disabled]:text-text-muted";

export function ContextMenuHost({ children }: { readonly children: ReactNode }): ReactNode {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const selection = useSelection();

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      if (!e.isTrusted) return; // our own re-dispatch
      const target = e.target;
      if (target instanceof Element && target.closest(NATIVE_MENU) !== null) return;
      e.preventDefault();
      // Refine the selection from the click point: an identifier keeps the
      // function it is inside, so fn-scoped actions still know their target.
      const word = wordAtPoint(e.clientX, e.clientY);
      const current = selection;
      if (word !== undefined && current.fn !== undefined) {
        select({
          kind: "identifier",
          name: word,
          fn: current.fn,
          ...(current.line !== undefined ? { line: current.line } : {}),
        });
      }
      setPos({ x: e.clientX, y: e.clientY });
      // Let the anchor move before Radix reads its position.
      requestAnimationFrame(() => {
        anchor.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
      });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, [selection]);

  const items = contextMenuFor(actionContext(), registry, keymap);

  return (
    <>
      {children}
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger asChild>
          <span ref={anchor} aria-hidden className="fixed h-px w-px" style={{ left: pos.x, top: pos.y }} />
        </ContextMenuPrimitive.Trigger>
        <ContextMenuPrimitive.Portal>
          <ContextMenuPrimitive.Content
            className="z-50 min-w-52 rounded-ui border border-border bg-surface p-1 text-text"
            data-hbc-keys="off"
          >
            {items.length === 0 && <div className="px-2 py-1 text-xs text-text-muted">nothing selected</div>}
            {items.map((item) => (
              <div key={item.id}>
                {item.separatorBefore && <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />}
                <ContextMenuPrimitive.Item className={itemClass} onSelect={() => void runAction(item.id)}>
                  <span className="flex-1">{item.title}</span>
                  {item.chord !== undefined && <span className="font-mono text-text-muted">{item.chord}</span>}
                </ContextMenuPrimitive.Item>
              </div>
            ))}
          </ContextMenuPrimitive.Content>
        </ContextMenuPrimitive.Portal>
      </ContextMenuPrimitive.Root>
    </>
  );
}
