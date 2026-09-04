// src/artifact/native.ts — §2.5 `native.jsonl`: a projection of calls.jsonl
// (builtins + `bridge-module` requires) + globals.jsonl (host-globals) for
// cheap querying (§2.5's own "this file is a projection" note). `bridge-module`
// rows reuse `src/deps/classify.ts`'s evidence for the SAME bundle rather than
// re-deriving it (§2.5): `nativeBoundaryModuleIds` turns a `ClassificationReport`
// into the set of local Metro module ids classify.ts named as a native-boundary
// package (`./native-boundary-packages.ts`); when no report is supplied (or it
// names none), zero `bridge-module` rows are emitted — truth rule, never a
// guessed/fabricated row.
import { classifyInventory, EMPTY_COMMONALITY_INDEX, type ClassificationReport } from "../deps/classify.ts";
import { buildInventoryFromModule } from "../deps/inventory.ts";
import type { HbcModule } from "../parse/types.ts";
import { HOST_GLOBALS_SET } from "./host-globals.ts";
import { NATIVE_BOUNDARY_PACKAGES_SET } from "./native-boundary-packages.ts";
import type { CallRow, GlobalRow, NativeRow } from "./schema.ts";

/** Auto-surfacing threshold (§9 ruling 2): an unlisted global read/called in
 *  at least this many distinct functions is a candidate, never a promotion. */
const AUTO_SURFACE_MIN_FNS = 3;

/** Local Metro module ids that `classify.ts` named (via `libraryPackageHint`)
 *  as one of `NATIVE_BOUNDARY_PACKAGES_SET` for THIS bundle's inventory.
 *  `report` is `undefined` when the caller has no classification available
 *  (e.g. a bare `calls.jsonl`/`globals.jsonl` pair with no bundle to
 *  classify) — returns an empty set, never a guess. */
export function nativeBoundaryModuleIds(report: ClassificationReport | undefined): ReadonlySet<number> {
  const out = new Set<number>();
  if (report === undefined) return out;
  for (const m of report.modules) {
    if (m.classification !== "library") continue;
    if (m.libraryPackageHint === null || !NATIVE_BOUNDARY_PACKAGES_SET.has(m.libraryPackageHint)) continue;
    if (m.localModuleId === null) continue;
    out.add(m.localModuleId);
  }
  return out;
}

/** `bridge-module`'s classification source for one bundle build: uses a
 *  caller-supplied `ClassificationReport` when given (e.g. `src/deps/index.ts`'s
 *  pipeline already ran with a real commonality index/npm confirmation for
 *  this bundle — reuse that stronger evidence rather than re-deriving a
 *  weaker one), otherwise builds a fresh report from `module`'s own inventory
 *  with `EMPTY_COMMONALITY_INDEX` (D17j's signals work standalone, no
 *  cross-app corpus needed — the always-available fallback for a plain
 *  `--split`/artifact build with no separate deps run). */
export function resolveBridgeModuleIds(module: HbcModule, classification: ClassificationReport | undefined): ReadonlySet<number> {
  const report = classification ?? classifyInventory(buildInventoryFromModule(module), EMPTY_COMMONALITY_INDEX);
  return nativeBoundaryModuleIds(report);
}

export function buildNativeIndex(callRows: readonly CallRow[], globalRows: readonly GlobalRow[], bridgeModuleIds: ReadonlySet<number> = new Set()): NativeRow[] {
  const rows: NativeRow[] = [];

  // builtin surface: exact, from CallBuiltin/CallBuiltinLong opcodes (calls.jsonl
  // kind:"builtin" rows already carry that — never inferred from AST shape,
  // see src/artifact/semantic-walk.ts's file header for why that matters).
  const builtinAgg = new Map<number, Map<string, number>>();
  for (const c of callRows) {
    if (c.kind !== "builtin" || typeof c.callee !== "string") continue;
    const perFn = builtinAgg.get(c.caller) ?? new Map<string, number>();
    perFn.set(c.callee, (perFn.get(c.callee) ?? 0) + 1);
    builtinAgg.set(c.caller, perFn);
  }
  for (const [fn, perFn] of builtinAgg) {
    for (const [name, n] of perFn) rows.push({ fn, surface: "builtin", name, n });
  }

  // bridge-module surface: `require` edges (calls.jsonl `kind:"require"`,
  // callee `m:<moduleId>` — the same numeric-id naming §2.2 already uses,
  // never a re-derived package path/name) whose target module is in
  // `bridgeModuleIds`. `name` re-emits the exact `callee` string so this
  // stays a pure projection of calls.jsonl (§2.5's own "projection" rule).
  if (bridgeModuleIds.size > 0) {
    const bridgeAgg = new Map<number, Map<string, number>>();
    for (const c of callRows) {
      if (c.kind !== "require" || typeof c.callee !== "string") continue;
      const id = Number(c.callee.slice(2));
      if (!Number.isInteger(id) || !bridgeModuleIds.has(id)) continue;
      const perFn = bridgeAgg.get(c.caller) ?? new Map<string, number>();
      perFn.set(c.callee, (perFn.get(c.callee) ?? 0) + 1);
      bridgeAgg.set(c.caller, perFn);
    }
    for (const [fn, perFn] of bridgeAgg) {
      for (const [name, n] of perFn) rows.push({ fn, surface: "bridge-module", name, n });
    }
  }

  // host-global surface: read/call access only (a write to e.g. `fetch` is
  // shadowing it, not touching the host boundary).
  const distinctFnsByGlobal = new Map<string, Set<number>>();
  const nByFnGlobal = new Map<number, Map<string, number>>();
  for (const g of globalRows) {
    if (g.access === "write") continue;
    const fns = distinctFnsByGlobal.get(g.g) ?? new Set<number>();
    fns.add(g.fn);
    distinctFnsByGlobal.set(g.g, fns);
    const perFn = nByFnGlobal.get(g.fn) ?? new Map<string, number>();
    perFn.set(g.g, (perFn.get(g.g) ?? 0) + g.n);
    nByFnGlobal.set(g.fn, perFn);
  }
  for (const [fn, perFn] of nByFnGlobal) {
    for (const [name, n] of perFn) {
      const curated = HOST_GLOBALS_SET.has(name);
      const candidate = curated || (distinctFnsByGlobal.get(name)?.size ?? 0) >= AUTO_SURFACE_MIN_FNS;
      if (!candidate) continue;
      rows.push({ fn, surface: curated ? "host-global" : "host-global?", name: `g:${name}`, n });
    }
  }

  rows.sort((a, b) => a.fn - b.fn || a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
  return rows;
}
