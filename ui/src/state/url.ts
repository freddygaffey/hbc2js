// ui/src/state/url.ts — spec 26 L10 (i)'s browser wiring: keeps
// `window.location` and the selection/right-panel stores in sync, in both
// directions. The pure encode/decode this relies on lives in
// `./url-codec.ts` (importable with no `ui/node_modules`, see its header);
// this file pulls in `./selection.ts` and `../actions/store.ts` for real
// (both need `react`), so it must never be imported from a root-level test —
// only from `App.tsx`.
//
// Every genuinely NEW selection (`select()`, which grows the jump list) gets
// its own `pushState` entry, so browser back/forward walk the same list the
// toolbar arrows do. Moving WITHIN the existing list (toolbar back/forward,
// or a real `popstate`) only ever `replaceState`s the current entry — it
// must never grow the stack a second time.
import { getSelection, jumpList, restoreSelection, sameSelection, subscribeSelection } from "./selection.ts";
import { getActionsState, setRightPanel, subscribeActions } from "../actions/store.ts";
import { decodeUrlState, DEFAULT_PANEL, encodeUrlState, NO_URL_SELECTION } from "./url-codec.ts";

export { DEFAULT_PANEL, decodeUrlState, encodeUrlState } from "./url-codec.ts";

let installed = false;
let lastEntryCount = 0;
let lastSearch = "";
let applyingPopstate = false;

function currentSearch(): string {
  return encodeUrlState(getSelection(), getActionsState().rightPanel);
}

/** `subscribeSelection`/`subscribeActions` fire on EVERY change to either
 *  store — a chord being recorded in the Settings dialog updates
 *  `pendingChord` on every keystroke, the palette open/close toggles
 *  `paletteOpen`, neither of which is URL state. Bailing out here when the
 *  encoded search string has not actually moved means those churn through
 *  with zero `history.*State` calls, not a redundant same-value one. */
function pushUrl(): void {
  if (applyingPopstate || typeof window === "undefined") return;
  const search = currentSearch();
  const entries = jumpList().entries.length;
  const grew = entries > lastEntryCount;
  lastEntryCount = entries;
  if (!grew && search === lastSearch) return;
  lastSearch = search;
  const url = search === "" ? window.location.pathname + window.location.hash : `?${search}${window.location.hash}`;
  if (grew) window.history.pushState({}, "", url);
  else window.history.replaceState({}, "", url);
}

function onPopState(): void {
  applyingPopstate = true;
  try {
    const { selection, panel } = decodeUrlState(window.location.search);
    if (!sameSelection(getSelection(), selection)) restoreSelection(selection);
    if (panel !== getActionsState().rightPanel) setRightPanel(panel);
    lastEntryCount = jumpList().entries.length;
    lastSearch = currentSearch();
  } finally {
    applyingPopstate = false;
  }
}

/** Call once, from App.tsx: seeds the initial selection/panel from
 *  `location.search`, then keeps the URL and the two stores in sync in both
 *  directions. Returns a cleanup function (removes the `popstate` listener)
 *  for hygiene in tests that mount/unmount the shell repeatedly; the live
 *  app never calls it. Idempotent — a second call is a no-op. */
export function initUrlSync(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;
  const { selection, panel } = decodeUrlState(window.location.search);
  if (!sameSelection(selection, NO_URL_SELECTION)) restoreSelection(selection);
  if (panel !== DEFAULT_PANEL) setRightPanel(panel);
  lastEntryCount = jumpList().entries.length;
  lastSearch = currentSearch();
  const unsubSel = subscribeSelection(pushUrl);
  const unsubActions = subscribeActions(pushUrl);
  window.addEventListener("popstate", onPopState);
  return () => {
    installed = false;
    unsubSel();
    unsubActions();
    window.removeEventListener("popstate", onPopState);
  };
}
