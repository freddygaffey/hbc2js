// ui/src/panes/context-native.ts — the PURE half of the Context pane's
// "native impl" row (docs/specs/27-native-side.md §L5). Extracted so
// `tests/ui-core/context-native.test.ts` (root gate, no browser, no
// `ui/node_modules`, same idiom as `ui/src/graph/model.ts` /
// `tests/ui-core/graph-cfg-model.test.ts`) can assert the exact label/detail
// text and the "shows a row for a seam fn, nothing for a non-seam fn" rule
// without mounting `RightPane.tsx`.
import type { NativeImpl, NativeImplRow } from "../contracts.ts";

/** `true` iff `fn`'s `/api/native/impl/:fn` answer has at least one seam —
 *  the gate `RightPane.tsx` uses to show/hide the whole "native impl"
 *  section. `undefined` (query not yet loaded) counts as no row to show. */
export function hasNativeImpl(data: NativeImpl | undefined): boolean {
  return (data?.rows.length ?? 0) > 0;
}

/** The row's left-hand label: `jsName.jsMethod`, or bare `jsName` (a
 *  view-manager/no-method seam), or the raw seam key when even `jsName` is
 *  unresolved (never blank). */
export function nativeImplLabel(row: NativeImplRow): string {
  const name = row.seam.jsName ?? row.seam.key;
  return row.seam.jsMethod !== null ? `${name}.${row.seam.jsMethod}` : name;
}

/** The row's muted detail text: seam status, the native module's kind when
 *  linked, and the first/third-party label when known (never guessed —
 *  `firstParty: null` prints nothing, same as the CLI/service's own
 *  null-is-a-fact rule). */
export function nativeImplDetail(row: NativeImplRow): string {
  let out: string = row.seam.status;
  if (row.module !== null) out += ` -> ${row.module.kind}`;
  if (row.seam.firstParty === true) out += " · first-party";
  else if (row.seam.firstParty === false) out += " · third-party";
  return out;
}
