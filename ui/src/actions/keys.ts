// ui/src/actions/keys.ts — spec 22 §3.2's DOM adapter: one window `keydown`
// listener that normalises the browser event and feeds it to the ui-core
// keymap, which is the ONLY place chords are decoded.
//
// What it deliberately ignores:
//   - typing in an <input>/<textarea>/<select> or a contenteditable (the
//     rename box, the search box, the finding form);
//   - anything inside an element marked `data-hbc-keys="off"`;
//   - the CodeMirror editor while the vim layer is in INSERT mode
//     (@replit/codemirror-vim drops the `cm-fat-cursor` class there), so a
//     vim `cf` never fires twice or eats an inserted character.
// A key the keymap does not resolve is left entirely to the browser.
import { createKeymap } from "@ui-core/keymap.ts";
import { vimEnabled } from "../keymap-config.ts";
import { setPendingChord } from "./store.ts";
import { keymap, runAction } from "./registry.ts";

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [data-hbc-keys="off"]';

/** Browser `key` values that are modifiers on their own — never chord steps. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"]);

export function shouldIgnoreKeyEvent(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE) !== null) return true;
  if (vimEnabled) {
    const editor = target.closest(".cm-editor");
    if (editor !== null && !editor.classList.contains("cm-fat-cursor")) return true; // vim insert mode
  }
  return false;
}

/** `KeyboardEvent` -> ui-core `KeyEvent`. Space is the named `Space` step. */
export function toKeyEvent(e: KeyboardEvent): Parameters<ReturnType<typeof createKeymap>["feed"]>[0] {
  return { key: e.key === " " ? "Space" : e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/** Installs the listener; returns the un-install function. */
export function installKeymapListener(): () => void {
  /** The keys typed so far in a pending sequence, for the chord indicator. */
  let pending = "";
  const onKeyDown = (e: KeyboardEvent): void => {
    if (MODIFIER_KEYS.has(e.key)) return;
    if (shouldIgnoreKeyEvent(e.target)) return;
    const result = keymap.feed(toKeyEvent(e));
    if (result === "pending") {
      pending += e.key === " " ? "␣" : e.key;
      setPendingChord(pending);
      e.preventDefault();
      return;
    }
    pending = "";
    setPendingChord("");
    if (result === "none") return;
    e.preventDefault();
    runAction(result.actionId);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
