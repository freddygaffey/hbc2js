// Evidence-ref resolution interface — docs/specs/11-project-store.md §4.1.
//
// A finding's evidence refs must RESOLVE against the live artifact index (a
// binding id), the string table (`sid:N`), the module graph (`mod:N`), or a
// named trace/fuzz artifact. This module defines only the INTERFACE a later
// step's real resolver (backed by `ArtifactService`, spec 10 — impl-plan
// step 4, §7) implements; it ships no implementation here.
// `tests/project/finding-evidence.test.ts` (P2) already exercises the RULE
// against a hand-rolled mock of this same one-method shape, and says in its
// own header comment that step 4 may repoint it at the real resolver once
// one exists — this file is that future target, defined early so step 3's
// write verbs can already type against it.

/** Resolves one evidence ref to true/false against whatever backs it: the
 *  artifact index for binding ids / `sid:`/`mod:` refs, or the trace/fuzz
 *  artifact store for `trace:`/`fuzz:` refs (§4.1). Pure boolean — a caller
 *  needing the ref's CLASS (e.g. "confirmed needs a dynamic-role ref", §4.1)
 *  reads `EvidenceRef.role`/parses the ref prefix itself; this interface only
 *  answers "does it exist". */
export interface EvidenceResolver {
  resolves(ref: string): boolean;
}

/** §4.1's write-time acceptance rule, shared so every write verb (and P2's
 *  test, whenever it repoints here) applies the identical rule: a finding
 *  needs >=1 evidence ref AND at least one of those refs must resolve. */
export function hasResolvingEvidence(evidence: readonly { readonly ref: string }[], resolver: EvidenceResolver): boolean {
  if (evidence.length === 0) return false;
  return evidence.some((e) => resolver.resolves(e.ref));
}
