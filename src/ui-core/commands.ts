// src/ui-core/commands.ts — bur 5 (docs/UI-BURS.md #5): the vim-style ":"
// command line, reusing the existing CommandPalette (no new component). This
// module is the PURE parser only — no DOM, no registry, no fetch — so it is
// node-testable exactly like keymap.ts. `ui/src/actions/registry.ts` owns
// executing a `ParsedCommand` (it needs the query client, the selection
// store and the keymap/theme stores to do that); this file only turns a
// typed string into structured intent.
//
// Grammar (everything after a leading ":" is stripped before parsing, so
// callers may pass either "fn 74" or ":fn 74"):
//   :<action-id>         fuzzy-matched against the registry's action ids
//   :fn <n>              open function n
//   :mod <id>            open module id (first function in it)
//   :goto <name>         search-and-open the first function whose name
//                        contains <name> (case-insensitive)
//   :q                   close the active right panel / dialog
//   :set theme <preset>  switch the theme preset
//   :set keymap <preset> switch the keymap preset
// Anything that does not match one of the verbs above falls back to
// `{ kind: "action", query }` — the palette fuzzy-matches `query` against
// action ids and titles, same as a normal (non-command) palette search.

export type ParsedCommand =
  | { readonly kind: "action"; readonly query: string }
  | { readonly kind: "fn"; readonly n: number }
  | { readonly kind: "mod"; readonly id: number }
  | { readonly kind: "goto"; readonly name: string }
  | { readonly kind: "quit" }
  | { readonly kind: "set"; readonly what: "theme" | "keymap"; readonly value: string };

/** True when `query` is in command mode (starts with ":") — what the
 *  palette uses to decide whether to show the verb row / fuzzy-on-ids list
 *  instead of the normal action list. */
export function isCommandQuery(query: string): boolean {
  return query.startsWith(":");
}

/** Parses a command-mode query (with or without its leading ":"). Never
 *  throws — an unrecognised verb, or a verb with a missing/malformed
 *  argument, falls back to `{ kind: "action", query: <trimmed body> }`. */
export function parseCommand(raw: string): ParsedCommand {
  const body = raw.startsWith(":") ? raw.slice(1) : raw;
  const trimmed = body.trim();
  const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const head = parts[0];

  if (head === "q" && parts.length === 1) return { kind: "quit" };

  if (head === "fn" && parts[1] !== undefined) {
    const n = Number.parseInt(parts[1], 10);
    if (!Number.isNaN(n)) return { kind: "fn", n };
  }

  if (head === "mod" && parts[1] !== undefined) {
    const id = Number.parseInt(parts[1], 10);
    if (!Number.isNaN(id)) return { kind: "mod", id };
  }

  if (head === "goto" && parts.length > 1) return { kind: "goto", name: parts.slice(1).join(" ") };

  if (head === "set" && (parts[1] === "theme" || parts[1] === "keymap") && parts[2] !== undefined) {
    return { kind: "set", what: parts[1], value: parts[2] };
  }

  return { kind: "action", query: trimmed };
}

/** A one-line human description of a verb command, shown as the palette's
 *  single result row while it is being typed. `undefined` for `{kind:
 *  "action"}` — that case renders the normal fuzzy-matched item list
 *  instead of a single synthetic row. */
export function describeCommand(cmd: ParsedCommand): string | undefined {
  switch (cmd.kind) {
    case "fn":
      return `Open function ${cmd.n}`;
    case "mod":
      return `Open module ${cmd.id}`;
    case "goto":
      return `Go to the first function named "${cmd.name}"`;
    case "quit":
      return "Close the active panel / dialog";
    case "set":
      return `Set ${cmd.what} to "${cmd.value}"`;
    case "action":
      return undefined;
  }
}

/** Case-insensitive subsequence fuzzy match (every character of `query`
 *  appears in `id`, in order) — enough for a short, dotted action-id list
 *  typed as `:partial-id`. Returns every id in `ids` when `query` is empty. */
export function fuzzyMatchIds(query: string, ids: readonly string[]): string[] {
  const q = query.toLowerCase();
  if (q === "") return [...ids];
  return ids.filter((id) => {
    const s = id.toLowerCase();
    let i = 0;
    for (const ch of q) {
      const next = s.indexOf(ch, i);
      if (next === -1) return false;
      i = next + 1;
    }
    return true;
  });
}
