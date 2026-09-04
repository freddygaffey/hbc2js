// ui/src/actions/names.ts — one place that answers "what is this function
// called now?". `McpResources.fn` adds `acceptedName` (the accepted overlay
// annotation) on top of the artifact's own `name`/`overlayName`; the UI must
// show the accepted name everywhere, or a rename looks like it did nothing.
// ui/src/contracts.ts is the listing track's file, so the extra field is
// declared here rather than edited into it.
import type { FnSummary } from "../contracts.ts";

/** `FnSummary` as `/api/fn/{fn}` and `/api/fn/{fn}/context` really send it. */
export interface AnnotatedFnSummary extends FnSummary {
  readonly acceptedName?: string;
  readonly suggestedNames?: readonly { readonly name: string; readonly who: string }[];
}

/** The name to show: accepted annotation > overlay > artifact name. */
export function displayName(md: FnSummary | undefined): string | null {
  if (md === undefined) return null;
  const annotated = md as AnnotatedFnSummary;
  return annotated.acceptedName ?? md.overlayName ?? md.name;
}
