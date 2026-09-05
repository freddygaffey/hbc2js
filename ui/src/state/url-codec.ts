// ui/src/state/url-codec.ts — spec 26 L10 "Address-style navigation": pure
// encode/decode between a `Selection` + the active right panel and the
// URL's query string (`?fn=&mod=&panel=…`). Deliberately has NO runtime
// import of `./selection.ts` or `../actions/store.ts` — both pull in
// `react` (`useSyncExternalStore`), and this file must run under plain
// `node:test` with no `ui/node_modules` present, same rule
// `ui/src/graph/model.ts` already follows (see tests/ui-core/graph-model.test.ts's
// header comment). Only TYPES are imported from them; `verbatimModuleSyntax`
// erases a type-only import at compile time, so it costs nothing at runtime.
//
// The browser-facing half — `history.pushState`/`popstate` wiring — lives in
// `./url.ts`, which imports this module plus the two stores; it is never
// imported by a root-level test.
//
// `RightPanel` is DUPLICATED, not imported, from `../actions/store.ts`:
// that module persists to `window.localStorage` (spec 26 L10 (iii)), which
// pulls `lib.dom` into tsc's requirements transitively — fine under
// `ui/tsconfig.json` (which has `dom`), fatal under the root `tsconfig.json`
// (which does not, and which this file must stay checkable under, per this
// test's header comment). If the two disagree, `../actions/store.ts` wins —
// same tie-break rule `ui/src/contracts.ts` already uses for its own
// structural copies.
import type { Selection, SelectionKind } from "./selection.ts";

export type RightPanel = "context" | "xrefs" | "strings" | "tables" | "graph" | "findings" | "package" | "workers" | "edit";

export const DEFAULT_PANEL: RightPanel = "context";

/** A `Selection` naming nothing — encodes to an EMPTY query string, never
 *  `fn=0` (spec 26 §1.2 row 21: fn 0 is the bytecode global function and is
 *  not a real selection). Structurally identical to `NO_SELECTION` in
 *  `./selection.ts`; kept as a local literal rather than a value import for
 *  the reason in the header comment. */
export const NO_URL_SELECTION: Selection = { kind: "none" };

const RIGHT_PANELS: readonly RightPanel[] = [
  "context", "xrefs", "strings", "tables", "graph", "findings", "package", "workers", "edit",
];

const SELECTION_KINDS: readonly SelectionKind[] = ["none", "fn", "identifier", "string", "module", "finding"];

function isRightPanel(v: string | null): v is RightPanel {
  return v !== null && (RIGHT_PANELS as readonly string[]).includes(v);
}

function isSelectionKind(v: string | null): v is SelectionKind {
  return v !== null && (SELECTION_KINDS as readonly string[]).includes(v);
}

function numOrUndefined(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Encode `selection` + `panel` as a query string (no leading `?`, no
 *  leading `&`). Only fields the selection's own kind uses are written, and
 *  `panel` is omitted when it is the default — so the common case ("nothing
 *  special picked") stays a short, clean URL. */
export function encodeUrlState(selection: Selection, panel: RightPanel): string {
  const params = new URLSearchParams();
  if (selection.kind !== "none") params.set("sel", selection.kind);
  if (selection.kind === "fn" || selection.kind === "identifier") {
    if (selection.fn !== undefined) params.set("fn", String(selection.fn));
  }
  if (selection.kind === "module" && selection.moduleId !== undefined) {
    params.set("mod", selection.moduleId);
  }
  if (selection.kind === "identifier" || selection.kind === "string") {
    if (selection.name !== undefined) params.set("name", selection.name);
  }
  if (selection.kind === "string" && selection.sid !== undefined) {
    params.set("sid", String(selection.sid));
  }
  if (selection.kind === "finding" && selection.rid !== undefined) {
    params.set("rid", String(selection.rid));
  }
  if (selection.line !== undefined) params.set("line", String(selection.line));
  if (panel !== DEFAULT_PANEL) params.set("panel", panel);
  return params.toString();
}

/** Decode a query string (with or without a leading `?`) back into a
 *  selection + panel. Unknown/malformed params are IGNORED, not fatal: a
 *  bad `sel=` or a non-numeric `fn=` degrades to "no selection" rather than
 *  throwing, and any param this module does not know about is simply never
 *  read. */
export function decodeUrlState(search: string): { readonly selection: Selection; readonly panel: RightPanel } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const panel = isRightPanel(params.get("panel")) ? (params.get("panel") as RightPanel) : DEFAULT_PANEL;
  const fn = numOrUndefined(params.get("fn"));
  const moduleId = params.get("mod") ?? undefined;
  const name = params.get("name") ?? undefined;
  const sid = numOrUndefined(params.get("sid"));
  const rid = numOrUndefined(params.get("rid"));
  const line = numOrUndefined(params.get("line"));

  // `sel` disambiguates when it is given (the shape `encodeUrlState` always
  // writes) — but a hand-typed or minimal link (the spec's own example is
  // literally `?fn=`, with no `sel`) must still work, so a bare identifying
  // param infers its kind. Precedence follows specificity: a finding id or
  // a module id can never mean anything else, `sid` before `name` because a
  // string selection always carries `sid` and `name` is common to two
  // kinds, `fn` last since almost every kind ends up carrying one too.
  function inferredKind(): SelectionKind {
    if (rid !== undefined) return "finding";
    if (moduleId !== undefined) return "module";
    if (sid !== undefined) return "string";
    if (name !== undefined) return "identifier";
    if (fn !== undefined) return "fn";
    return "none";
  }
  const kindParam = params.get("sel");
  const kind: SelectionKind = isSelectionKind(kindParam) ? kindParam : inferredKind();

  const complete =
    (kind === "fn" && fn !== undefined) ||
    (kind === "identifier" && name !== undefined) ||
    (kind === "string" && sid !== undefined) ||
    (kind === "module" && moduleId !== undefined) ||
    (kind === "finding" && rid !== undefined);
  if (kind === "none" || !complete) return { selection: NO_URL_SELECTION, panel };

  const selection: Selection = {
    kind,
    ...(fn !== undefined ? { fn } : {}),
    ...(moduleId !== undefined ? { moduleId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(sid !== undefined ? { sid } : {}),
    ...(rid !== undefined ? { rid } : {}),
    ...(line !== undefined ? { line } : {}),
  };
  return { selection, panel };
}
