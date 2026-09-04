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

/** True on macOS, where the COMMAND key is what a user presses for every
 *  chord a Windows/Linux user presses Ctrl for. `navigator.platform` is
 *  deprecated but still the most reliable signal in every browser we run in;
 *  the user-agent string is the fallback. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (nav === undefined) return false;
  return /Mac|iPhone|iPad|iPod/.test(nav.platform ?? nav.userAgent ?? "");
}

/** `KeyboardEvent` -> ui-core `KeyEvent`. Space is the named `Space` step.
 *
 *  On macOS a lone COMMAND is folded into `ctrl` (review-2026-09-05-keys,
 *  docs/BUGS.md): every preset writes its chords as `Ctrl-…` — the top bar
 *  itself advertises "Cmd/Ctrl-K" — but a Mac user never presses Control, so
 *  the whole default keymap was unreachable on the owner's machine. No preset
 *  binds a `Meta-` chord, so nothing is shadowed; a Command chord that is not
 *  bound still resolves to "none" and is left to the browser (Cmd-R, Cmd-T,
 *  Cmd-C … are untouched). */
export function toKeyEvent(e: KeyboardEvent, mac: boolean = isMacPlatform()): Parameters<ReturnType<typeof createKeymap>["feed"]>[0] {
  const foldMeta = mac && e.metaKey && !e.ctrlKey;
  return {
    key: e.key === " " ? "Space" : e.key,
    ctrl: e.ctrlKey || foldMeta,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: foldMeta ? false : e.metaKey,
  };
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
