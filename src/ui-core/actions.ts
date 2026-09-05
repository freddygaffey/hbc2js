// src/ui-core/actions.ts — docs/specs/22-ui-mvp.md §3.1 (action registry) and
// §3.3 (context menu). Invariant: the context menu, the command palette, and
// the keymap are three *views* over this one registry — add an action here
// and it appears in the menu, the palette, and (once a preset binds a chord
// to its id) the keymap, all at once. Nothing outside this file should hold
// its own list of commands.
//
// Pure TypeScript, no DOM, no React, no dependencies — importable from
// Node tests and from the browser shell alike.

export type SelectionKind = "fn" | "identifier" | "string" | "module" | "finding" | "lead" | "none";

export interface Selection {
  kind: SelectionKind;
  /** Function id/index, when kind is "fn" or the selection is inside a function. */
  fn?: number;
  /** Identifier/string text, when kind is "identifier" or "string". */
  name?: string;
  /** String-table id, when kind is "string". */
  sid?: number;
  /** Module id, when kind is "module". */
  moduleId?: string;
  /** Finding/review-row id, when kind is "finding". */
  rid?: number;
  /** Spec 26 L6: whether the finding's evidence resolves (`ResolvedFinding.
   *  valid`) — `finding.setStatus` is gated on this, exactly like
   *  `record_finding`'s own truth rule 1 (a candidate that never resolves
   *  stays refused server-side; the UI does not let a status change even
   *  start against one). Present only when kind is "finding". */
  evidenceResolved?: boolean;
  /** Spec 26 L6: the sink class/evidence/detail of a lead row (`SinkLead`,
   *  `src/mcp/leads.ts`), present only when kind is "lead" — `finding.
   *  fromLead` prefills the "Add finding" form from these three fields
   *  rather than starting blank. */
  leadClass?: string;
  leadEvidence?: string;
  leadDetail?: string;
}

export type FocusPane = "editor" | "tree" | "search" | "palette" | "graph" | "findings";

/**
 * Abstract surface the shell implements. Actions call only these methods,
 * never touch the DOM or React state directly, so the registry stays pure
 * and testable without a browser.
 */
export interface ActionApi {
  setName(target: Selection, name: string): void | Promise<void>;
  addComment(target: Selection, text: string): void | Promise<void>;
  /** Spec 22 §3.6: open the "add finding" form pre-filled from `target`
   *  (a function or module selection) and POST it to `record_finding`. */
  recordFinding(target: Selection): void | Promise<void>;
  gotoFn(fn: number): void | Promise<void>;
  showXrefs(target: Selection): void | Promise<void>;
  /** Spec 22 §3: switch the right pane to the Strings/Globals xref window,
   *  pre-filling its search from `target` when it is a `"string"` selection
   *  (a clicked string literal) — otherwise just opens the window empty. */
  showStrings(target: Selection): void | Promise<void>;
  /** Spec 17 §14.2: switch the right pane to the Tables (object-literal
   *  inventory) window, pre-filling its value filter from `target` when it
   *  is a `"string"` selection — otherwise just opens the window with the
   *  server's own defaults applied. */
  showTables(target: Selection): void | Promise<void>;
  search(query?: string): void | Promise<void>;
  openPalette(): void | Promise<void>;
  markReviewed(target: Selection): void | Promise<void>;
  markSuspicious(target: Selection): void | Promise<void>;
  copyDisasmOffset(target: Selection): void | Promise<void>;
  showRawHermes(target: Selection): void | Promise<void>;
  explain(target: Selection): void | Promise<void>;
  suggestName(target: Selection): void | Promise<void>;
  openGraph(target: Selection): void | Promise<void>;
  /** Bur 9/10 (docs/UI-BURS.md, spec 25 §5a/§5b): the graph pane's two
   *  view toggles. `toggleGraphFollow` flips "track the listing selection";
   *  `cycleGraphLod` steps the semantic-zoom level far -> mid -> near. Both
   *  are pane state, so a shell with no graph pane implements them as
   *  no-ops. */
  toggleGraphFollow(): void | Promise<void>;
  cycleGraphLod(): void | Promise<void>;
  /** Bur 13 (docs/UI-BURS.md #13): arrow-key navigation inside the listing.
   *  `listingLineDown`/`listingLineUp` step the selection to the next/
   *  previous line; `listingTokenLeft`/`listingTokenRight` step it to the
   *  previous/next token on the CURRENT line (no wrap). A shell with no
   *  listing on screen — or no listing pane at all — implements these as
   *  no-ops, exactly like the graph toggles above. */
  listingLineDown(): void | Promise<void>;
  listingLineUp(): void | Promise<void>;
  listingTokenLeft(): void | Promise<void>;
  listingTokenRight(): void | Promise<void>;
  nextFn(): void | Promise<void>;
  prevFn(): void | Promise<void>;
  nextModule(): void | Promise<void>;
  prevModule(): void | Promise<void>;
  back(): void | Promise<void>;
  forward(): void | Promise<void>;
  fold(): void | Promise<void>;
  unfold(): void | Promise<void>;
  /** The keyboard cheat-sheet: every live binding, from the live keymap. */
  openShortcuts(): void | Promise<void>;
  /** The Settings dialog (theme preset, density, keymap preset + bindings). */
  openSettings(): void | Promise<void>;
  /** Bur 5 (docs/UI-BURS.md #5): opens the command palette prefilled with
   *  ":" — vim-style command mode (`:fn 74`, `:mod 3`, `:goto name`, `:q`,
   *  `:set theme/keymap <preset>`, or `:<action-id>` fuzzy-matched). */
  openCommandMode(): void | Promise<void>;
  /** Bur 6 (docs/UI-BURS.md #6): flips the active theme preset to its
   *  dark/light partner (docs/UI.md "Theme"). */
  toggleTheme(): void | Promise<void>;
  /** Spec 26 L6: promote a lead (`target.kind === "lead"`) to a candidate
   *  finding — opens the same "Add finding" form `recordFinding` does,
   *  prefilled from the lead's class/evidence/detail rather than blank. */
  promoteLead(target: Selection): void | Promise<void>;
  /** Spec 26 L6: open the status-transition control for a finding
   *  (`target.kind === "finding"`) — `set_finding_status`, with the
   *  backend's own rejection surfaced verbatim on a bad transition. */
  setFindingStatus(target: Selection): void | Promise<void>;
  /** Spec 26 L6: `GET /api/history/{target}` for the current selection's
   *  target (a function or a module) — the full revision timeline. */
  showHistory(target: Selection): void | Promise<void>;
}

export interface ActionContext {
  selection: Selection;
  focusPane: FocusPane;
  api: ActionApi;
}

export type ActionGroup = "navigate" | "annotate" | "review" | "view" | "ai" | "project";

export interface Action {
  id: string;
  title: string;
  /** A title that depends on what is selected — the context menu shows this
   *  when present (`Rename "r3"` on an identifier), and falls back to
   *  `title` everywhere else (the palette, a keyboard chord, no selection). */
  titleFor?: (ctx: ActionContext) => string;
  group: ActionGroup;
  when?: (ctx: ActionContext) => boolean;
  run: (ctx: ActionContext) => void | Promise<void>;
  defaultChord?: string;
}

export interface Registry {
  register(action: Action): void;
  get(id: string): Action | undefined;
  list(): Action[];
  enabledFor(ctx: ActionContext): Action[];
  run(id: string, ctx: ActionContext): void | Promise<void>;
}

function hasIdentifierTarget(ctx: ActionContext): boolean {
  return ctx.selection.kind === "identifier" || ctx.selection.kind === "fn" || ctx.selection.kind === "string";
}

function hasFnTarget(ctx: ActionContext): boolean {
  return ctx.selection.kind === "fn" && ctx.selection.fn !== undefined;
}

/** `view.fold`/`view.unfold` need a listing on screen: a module selection,
 *  or any selection that carries an `fn` (a plain `"fn"` selection, but also
 *  `"identifier"`/`"string"`/`"finding"` selections inside a function —
 *  those still have a listing under them). Previously a UI-only override in
 *  `ui/src/actions/registry.ts` (`registry.register()` overwrote the shared
 *  definition's `when`); moved here so every shell shares the same gate. */
function hasListingTarget(ctx: ActionContext): boolean {
  return ctx.selection.kind === "module" || ctx.selection.fn !== undefined;
}

function alwaysFalse(): boolean {
  return false;
}

/**
 * The standard action set from spec 22 §3.3. `view.graph` is still
 * registered disabled (`when: () => false`) — greyed out in menu and
 * palette — until the graph spec lands; keymap resolution still finds its
 * id so preset JSON referencing it is not "dangling". The `ai.*` pair is
 * ENABLED as of spec 23 (the server owns the workers; see below).
 */
export function standardActions(): Action[] {
  return [
    {
      id: "navigate.definition",
      title: "Go to definition",
      group: "navigate",
      when: hasIdentifierTarget,
      run: (ctx) => {
        const fn = ctx.selection.fn;
        if (fn !== undefined) return ctx.api.gotoFn(fn);
      },
    },
    {
      id: "navigate.xrefs",
      title: "Find references",
      group: "navigate",
      when: hasIdentifierTarget,
      run: (ctx) => ctx.api.showXrefs(ctx.selection),
    },
    {
      id: "navigate.strings",
      title: "Find string uses…",
      group: "navigate",
      run: (ctx) => ctx.api.showStrings(ctx.selection),
    },
    {
      id: "navigate.tables",
      title: "Find object tables…",
      group: "navigate",
      run: (ctx) => ctx.api.showTables(ctx.selection),
    },
    {
      id: "navigate.nextFn",
      title: "Next function",
      group: "navigate",
      run: (ctx) => ctx.api.nextFn(),
    },
    {
      id: "navigate.prevFn",
      title: "Previous function",
      group: "navigate",
      run: (ctx) => ctx.api.prevFn(),
    },
    {
      id: "navigate.nextModule",
      title: "Next module",
      group: "navigate",
      run: (ctx) => ctx.api.nextModule(),
    },
    {
      id: "navigate.prevModule",
      title: "Previous module",
      group: "navigate",
      run: (ctx) => ctx.api.prevModule(),
    },
    {
      id: "navigate.back",
      title: "Back",
      group: "navigate",
      run: (ctx) => ctx.api.back(),
    },
    {
      id: "navigate.forward",
      title: "Forward",
      group: "navigate",
      run: (ctx) => ctx.api.forward(),
    },
    {
      id: "annotate.rename",
      title: "Rename",
      titleFor: (ctx) => (ctx.selection.kind === "identifier" && (ctx.selection.name ?? "") !== "" ? `Rename "${ctx.selection.name}"` : "Rename"),
      group: "annotate",
      when: hasIdentifierTarget,
      run: (ctx) => ctx.api.setName(ctx.selection, ctx.selection.name ?? ""),
    },
    {
      id: "annotate.comment",
      title: "Add comment",
      group: "annotate",
      when: hasIdentifierTarget,
      run: (ctx) => ctx.api.addComment(ctx.selection, ""),
    },
    {
      id: "annotate.finding",
      title: "Add finding",
      group: "annotate",
      when: (ctx) => ctx.selection.kind !== "none",
      run: (ctx) => ctx.api.recordFinding(ctx.selection),
    },
    // Spec 26 L6: lead promotion, the status-transition control, and the
    // per-target history view — three thin actions over verbs the backend
    // already tests (spec 19 §1.4: "no analysis logic" in the UI).
    {
      id: "finding.fromLead",
      title: "Promote to finding",
      group: "annotate",
      when: (ctx) => ctx.selection.kind === "lead",
      run: (ctx) => ctx.api.promoteLead(ctx.selection),
    },
    {
      id: "finding.setStatus",
      title: "Set status",
      group: "annotate",
      when: (ctx) => ctx.selection.kind === "finding" && ctx.selection.evidenceResolved === true,
      run: (ctx) => ctx.api.setFindingStatus(ctx.selection),
    },
    {
      id: "view.history",
      title: "History",
      group: "view",
      when: hasListingTarget,
      run: (ctx) => ctx.api.showHistory(ctx.selection),
    },
    {
      id: "review.markReviewed",
      title: "Mark reviewed",
      group: "review",
      when: (ctx) => ctx.selection.kind !== "none",
      run: (ctx) => ctx.api.markReviewed(ctx.selection),
    },
    {
      id: "review.markSuspicious",
      title: "Mark suspicious",
      group: "review",
      when: (ctx) => ctx.selection.kind !== "none",
      run: (ctx) => ctx.api.markSuspicious(ctx.selection),
    },
    {
      id: "view.copyDisasmOffset",
      title: "Copy disasm offset",
      group: "view",
      when: hasFnTarget,
      run: (ctx) => ctx.api.copyDisasmOffset(ctx.selection),
    },
    {
      id: "view.rawHermes",
      title: "Show raw Hermes",
      group: "view",
      when: hasFnTarget,
      run: (ctx) => ctx.api.showRawHermes(ctx.selection),
    },
    {
      id: "view.fold",
      title: "Fold",
      group: "view",
      when: hasListingTarget,
      run: (ctx) => ctx.api.fold(),
    },
    {
      id: "view.unfold",
      title: "Unfold",
      group: "view",
      when: hasListingTarget,
      run: (ctx) => ctx.api.unfold(),
    },
    // Spec 25 §5a/§5b (burs 9, 10): the graph pane's own view toggles.
    // Unlike `view.graph` these are NOT gated off - they are pane state a
    // shell either has or no-ops, and the shipped presets bind chords to
    // them (`g f`, `g z`), which `tests/gate/ui/keymap-default.test.ts`
    // requires to name a real action.
    {
      id: "graph.followToggle",
      title: "Graph: follow the selection (on/off)",
      group: "view",
      run: (ctx) => ctx.api.toggleGraphFollow(),
    },
    {
      id: "graph.lodCycle",
      title: "Graph: cycle zoom level (far/mid/near)",
      group: "view",
      run: (ctx) => ctx.api.cycleGraphLod(),
    },
    {
      id: "view.graph",
      title: "Open in graph",
      group: "view",
      when: alwaysFalse,
      run: (ctx) => ctx.api.openGraph(ctx.selection),
    },
    // Bur 13: Up/Down/Left/Right in the listing (docs/UI-BURS.md #13),
    // gated the same way as `view.fold`/`view.unfold` — a listing needs a
    // module or a function-carrying selection on screen before there is
    // anything to move a cursor over.
    {
      id: "listing.lineDown",
      title: "Move down a line",
      group: "navigate",
      when: hasListingTarget,
      run: (ctx) => ctx.api.listingLineDown(),
    },
    {
      id: "listing.lineUp",
      title: "Move up a line",
      group: "navigate",
      when: hasListingTarget,
      run: (ctx) => ctx.api.listingLineUp(),
    },
    {
      id: "listing.tokenLeft",
      title: "Move left a token",
      group: "navigate",
      when: hasListingTarget,
      run: (ctx) => ctx.api.listingTokenLeft(),
    },
    {
      id: "listing.tokenRight",
      title: "Move right a token",
      group: "navigate",
      when: hasListingTarget,
      run: (ctx) => ctx.api.listingTokenRight(),
    },
    // ENABLED as of spec 23 (docs/specs/23-ui-workers.md §6: accept/reject
    // and the two enqueue actions are "ordinary entries in spec 22 §3.1's
    // action registry, so they get a keybinding and a context-menu item for
    // free"). They need a function to work on, nothing more — the queue is
    // the server's, and it answers 503 when the pool is off, which the shell
    // reports as a status line rather than a disabled menu item.
    {
      id: "ai.explain",
      title: "Explain",
      group: "ai",
      when: hasFnTarget,
      run: (ctx) => ctx.api.explain(ctx.selection),
    },
    {
      id: "ai.suggestName",
      title: "Suggest name",
      group: "ai",
      when: hasFnTarget,
      run: (ctx) => ctx.api.suggestName(ctx.selection),
    },
    {
      id: "project.palette",
      title: "Open command palette",
      group: "project",
      run: (ctx) => ctx.api.openPalette(),
    },
    {
      id: "project.search",
      title: "Search project",
      group: "project",
      run: (ctx) => ctx.api.search(),
    },
    {
      id: "project.shortcuts",
      title: "Keyboard shortcuts",
      group: "project",
      run: (ctx) => ctx.api.openShortcuts(),
    },
    {
      id: "project.settings",
      title: "Settings",
      group: "project",
      run: (ctx) => ctx.api.openSettings(),
    },
    {
      id: "project.commandMode",
      title: "Open command line",
      group: "project",
      run: (ctx) => ctx.api.openCommandMode(),
    },
    {
      id: "view.themeToggle",
      title: "Toggle light/dark theme",
      group: "view",
      run: (ctx) => ctx.api.toggleTheme(),
    },
  ];
}

export function createRegistry(): Registry {
  const actions = new Map<string, Action>();

  function register(action: Action): void {
    actions.set(action.id, action);
  }

  function get(id: string): Action | undefined {
    return actions.get(id);
  }

  function list(): Action[] {
    return [...actions.values()];
  }

  function enabledFor(ctx: ActionContext): Action[] {
    return list().filter((a) => a.when === undefined || a.when(ctx));
  }

  function run(id: string, ctx: ActionContext): void | Promise<void> {
    const action = actions.get(id);
    if (!action) throw new Error(`ui-core/actions: unknown action id "${id}"`);
    if (action.when !== undefined && !action.when(ctx)) {
      throw new Error(`ui-core/actions: action "${id}" is not enabled for this context`);
    }
    return action.run(ctx);
  }

  return { register, get, list, enabledFor, run };
}

/** Registers the standard action set (§3.3) on a fresh registry. */
export function createStandardRegistry(): Registry {
  const registry = createRegistry();
  for (const action of standardActions()) registry.register(action);
  return registry;
}

const GROUP_ORDER: ActionGroup[] = ["navigate", "annotate", "review", "view", "ai", "project"];

export interface MenuItem {
  id: string;
  title: string;
  group: ActionGroup;
  chord?: string;
  separatorBefore: boolean;
}

/**
 * Builds context-menu items (§3.3): actions enabled for `ctx`, grouped in
 * `GROUP_ORDER`, with a separator before the first item of each new group,
 * each item carrying its keymap chord label (if the active keymap binds one).
 */
export function contextMenuFor(ctx: ActionContext, registry: Registry, keymap: { chordFor(id: string): string | undefined }): MenuItem[] {
  const enabled = registry.enabledFor(ctx);
  const byGroup = new Map<ActionGroup, Action[]>();
  for (const action of enabled) {
    const bucket = byGroup.get(action.group);
    if (bucket) bucket.push(action);
    else byGroup.set(action.group, [action]);
  }
  const items: MenuItem[] = [];
  for (const group of GROUP_ORDER) {
    const bucket = byGroup.get(group);
    if (!bucket || bucket.length === 0) continue;
    bucket.forEach((action, i) => {
      const chord = keymap.chordFor(action.id);
      const item: MenuItem = {
        id: action.id,
        title: action.titleFor?.(ctx) ?? action.title,
        group: action.group,
        separatorBefore: i === 0 && items.length > 0,
        ...(chord !== undefined ? { chord } : {}),
      };
      items.push(item);
    });
  }
  return items;
}

export interface PaletteItem {
  id: string;
  title: string;
  group: ActionGroup;
}

/** Command-palette items: same registry, same `enabledFor`, no grouping/separators. */
export function paletteItems(ctx: ActionContext, registry: Registry): PaletteItem[] {
  return registry.enabledFor(ctx).map((a) => ({ id: a.id, title: a.title, group: a.group }));
}
