// ui/src/listing/modules.ts — the left pane's tree shape, as pure functions
// so the gate can reason about them without a browser. Spec 22 §3.2: the
// module tree groups third-party packages (`node_modules/<pkg>`) apart from
// the app's own modules, because in a real bundle 90% of the modules are
// someone else's and collapsing them is the first thing an analyst does.
import type { FunctionListRow, ModuleEntry } from "./wire.ts";

export type GroupKind = "app" | "pkg" | "other";

export interface ModuleGroup {
  /** Stable key for React and for the open/closed set. */
  readonly key: string;
  readonly label: string;
  readonly kind: GroupKind;
  readonly modules: readonly ModuleEntry[];
}

/** `node_modules/@scope/name/...` -> `@scope/name`; `node_modules/name/...`
 *  -> `name`; anything else -> null. Tolerates leading `./`, `../` and
 *  Windows separators (Metro emits both on different platforms). */
export function packageOf(file: string): string | null {
  const norm = file.replace(/\\/g, "/");
  const i = norm.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const rest = norm.slice(i + "node_modules/".length).split("/").filter((s) => s.length > 0);
  if (rest.length === 0) return null;
  const head = rest[0]!;
  if (head.startsWith("@")) return rest.length > 1 ? `${head}/${rest[1]!}` : head;
  return head;
}

/** The group a module belongs to. App modules all land in one `src/` group;
 *  each package gets its own. Unknown/empty paths get `(no path)`. */
export function groupKeyOf(file: string | null): { readonly key: string; readonly label: string; readonly kind: GroupKind } {
  if (file === null || file.trim() === "") return { key: "other", label: "(no path)", kind: "other" };
  const pkg = packageOf(file);
  if (pkg !== null) return { key: `pkg:${pkg}`, label: `node_modules/${pkg}`, kind: "pkg" };
  return { key: "app", label: "src/", kind: "app" };
}

/** Group + sort: the app's own modules first, then packages alphabetically,
 *  then the unknown-path bucket. Modules inside a group sort by path. */
export function groupModules(rows: readonly ModuleEntry[]): readonly ModuleGroup[] {
  const byKey = new Map<string, { label: string; kind: GroupKind; modules: ModuleEntry[] }>();
  for (const m of rows) {
    const g = groupKeyOf(m.file);
    let bucket = byKey.get(g.key);
    if (bucket === undefined) {
      bucket = { label: g.label, kind: g.kind, modules: [] };
      byKey.set(g.key, bucket);
    }
    bucket.modules.push(m);
  }
  const rank: Record<GroupKind, number> = { app: 0, pkg: 1, other: 2 };
  return [...byKey.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      kind: b.kind,
      modules: [...b.modules].sort((a, c) => a.file.localeCompare(c.file) || a.id - c.id),
    }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
}

/** `fn` rows bucketed by owning module, each bucket sorted by fn id. Rows
 *  with `module === null` are dropped: they belong to no module row. */
export function functionsByModule(rows: readonly FunctionListRow[]): ReadonlyMap<number, readonly FunctionListRow[]> {
  const out = new Map<number, FunctionListRow[]>();
  for (const r of rows) {
    if (r.module === null) continue;
    const bucket = out.get(r.module);
    if (bucket === undefined) out.set(r.module, [r]);
    else bucket.push(r);
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.fn - b.fn);
  return out;
}

/** The label a function row shows: its name, or `fn N` when the bundle
 *  stripped it (minified bundles strip most of them). */
export function fnLabel(row: { readonly fn: number; readonly name: string | null }): string {
  return row.name !== null && row.name !== "" ? row.name : `fn ${row.fn}`;
}

/** The module path, shortened for the tree: the part after the group prefix. */
export function moduleLabel(m: ModuleEntry): string {
  const pkg = packageOf(m.file);
  if (pkg === null) return m.file === "" ? `module ${m.id}` : m.file;
  const norm = m.file.replace(/\\/g, "/");
  const marker = `node_modules/${pkg}/`;
  const i = norm.lastIndexOf(marker);
  return i < 0 ? norm : norm.slice(i + marker.length);
}
