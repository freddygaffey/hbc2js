// src/artifact/native.ts — §2.5 `native.jsonl`: a projection of calls.jsonl
// (builtins) + globals.jsonl (host-globals) for cheap querying (§2.5's own
// "this file is a projection" note). `bridge-module` rows (requires of
// `src/deps`-classified native-boundary packages) are DEFERRED — see
// docs/BUGS.md's P2.1-native-bridge-modules row; zero rows emitted for that
// surface rather than a guessed one (truth rule, never a fabricated row).
import { HOST_GLOBALS_SET } from "./host-globals.ts";
import type { CallRow, GlobalRow, NativeRow } from "./schema.ts";

/** Auto-surfacing threshold (§9 ruling 2): an unlisted global read/called in
 *  at least this many distinct functions is a candidate, never a promotion. */
const AUTO_SURFACE_MIN_FNS = 3;

export function buildNativeIndex(callRows: readonly CallRow[], globalRows: readonly GlobalRow[]): NativeRow[] {
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
