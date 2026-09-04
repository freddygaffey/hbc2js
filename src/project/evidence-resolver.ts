// Evidence-ref resolution — docs/specs/11-project-store.md §4.1, §7 step 4.
//
// A finding's evidence refs must RESOLVE against the live artifact index (a
// binding id), the string table (`sid:N`), the module graph (`mod:N`), or a
// named trace/fuzz artifact. `EvidenceResolver` is the interface every write
// verb and read-time liveness check codes against;
// `tests/project/finding-evidence.test.ts` (P2) exercises the RULE
// (`hasResolvingEvidence`) against a hand-rolled mock of this same
// one-method shape, exactly as spec 11 §6 prescribes for P2 ("runnable
// against a mock ArtifactService resolver") — it is not repointed at
// `ArtifactEvidenceResolver` below, which is exercised directly by
// `tests/project/evidence-resolver.test.ts` against a real artifact instead.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../util/paths.ts";

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
 *  test) applies the identical rule: a finding needs >=1 evidence ref AND
 *  at least one of those refs must resolve. Re-run at READ time too (§3.3)
 *  against the live index — same function, same rule, no drift between the
 *  write-time gate and the read-time liveness check. */
export function hasResolvingEvidence(evidence: readonly { readonly ref: string }[], resolver: EvidenceResolver): boolean {
  if (evidence.length === 0) return false;
  return evidence.some((e) => resolver.resolves(e.ref));
}

/** §4.1's "dynamic role" test for `open->confirmed` (§4.1/§4.3): a ref whose
 *  prefix names a trace/fuzz/repro artifact, not a static binding id — a
 *  static-only claim can never self-promote to confirmed. Checked on the
 *  REF's prefix (the vocabulary spec 11 §1.5's worked example uses:
 *  `trace:campaign1/seed-777007`, `fuzz:tests/fixtures/adversarial/43-…`),
 *  not on the free-text `role` field, which spec 11 leaves open (spec 12
 *  §4.2 review: "spec 11 names no closed role enum"). */
export function isDynamicEvidenceRef(ref: { readonly ref: string }): boolean {
  return /^(trace|fuzz|repro):/.test(ref.ref);
}

/** §14's write-side fix (docs/specs/17-mcp-harness.md §14, 2026-09-04,
 *  BINDING): "`set_finding_status → confirmed` accepts EITHER a dynamic
 *  repro OR a fidelity-checked STATIC proof. Dynamic-only over-constrains: a
 *  hardcoded key, or a signature parsed-but-never-checked, is provable from
 *  the code alone." A ref is a fidelity-checked static proof when its
 *  `role` is stamped `"fidelity-checked"` — the marker `request_fidelity_check`
 *  (deferred to a later round, spec 17 §2) stamps onto the STATIC ref it
 *  independently verified, distinguishing "the assistant read this itself"
 *  from "the spec-16 §5 checker confirmed it" without inventing a new ref
 *  prefix (spec 11 §4.2: "the base shape is `{ref, role}`... producers may
 *  attach extra descriptive fields", `role` is exactly that open vocabulary).
 *  Still gated by `resolver.resolves` like every other evidence ref — a
 *  fidelity-checked ref that no longer resolves (stale re-decompile) is not
 *  confirming evidence either. */
export function isFidelityCheckedEvidenceRef(ref: { readonly role: string }): boolean {
  return ref.role === "fidelity-checked";
}

/** The four evidence-ref kinds §4.1 names as resolving against the artifact
 *  index (binding id / `sid:` / `mod:` / a use-site `fn:` ref, all covered by
 *  `fn:`/`reg:`/`sid:`/`mod:` prefixes here) vs. the trace/fuzz artifact
 *  store. An unrecognised prefix is always unresolvable — never guessed. */
type RefKind = "fn" | "reg" | "sid" | "mod" | "trace" | "fuzz" | "repro" | "unknown";

function refKind(ref: string): RefKind {
  const m = /^([a-z]+):/.exec(ref);
  const prefix = m?.[1];
  if (prefix === "fn" || prefix === "reg" || prefix === "sid" || prefix === "mod" || prefix === "trace" || prefix === "fuzz" || prefix === "repro") {
    return prefix;
  }
  return "unknown";
}

/** What backs `trace:`/`fuzz:`/`repro:` ref resolution — injected so tests
 *  (and, later, a real trace/fuzz corpus store once one exists in this repo;
 *  none does yet, no harness module indexes named campaigns/seeds) can
 *  supply their own check without `ArtifactEvidenceResolver` guessing. The
 *  default (`defaultDynamicResolver`) below is the only honest zero-config
 *  answer available today: a `fuzz:<path>` ref resolves iff that path exists
 *  on disk relative to the repo root (the spec's own worked example is a
 *  literal fixture path); `trace:`/`repro:` refs have no on-disk artifact
 *  shape yet, so they are unresolvable by default rather than guessed true —
 *  "unknown-kind refs = unresolvable, never guessed" extends to a known-kind
 *  ref whose backing store doesn't exist yet. */
export interface DynamicResolver {
  resolves(ref: string): boolean;
}

/** The zero-config default: a `fuzz:<path>` ref resolves iff that path
 *  exists on disk relative to the repo root; `trace:`/`repro:` refs have no
 *  on-disk shape yet (module header) so they always miss. */
export const defaultDynamicResolver: DynamicResolver = {
  resolves(ref: string): boolean {
    if (!ref.startsWith("fuzz:")) return false;
    const rel = ref.slice("fuzz:".length);
    return existsSync(join(repoRoot(), rel));
  },
};

/** §4.1's real, `ArtifactService`-backed resolver: `fn:N` / `reg:F:R` /
 *  `sid:N` / `mod:N` refs resolve against the loaded artifact's index;
 *  `trace:`/`fuzz:`/`repro:` refs go to the injected `DynamicResolver`; any
 *  other prefix is unresolvable, never guessed (§4.1's own wording). This is
 *  what `ProjectService.setFinding*`/`setFindingStatus` (step 5) and
 *  `FindingStore`'s read-time liveness check (`src/project/findings.ts`)
 *  both construct over a warm `ArtifactService` — the resolver `evidence-
 *  resolver.ts`'s header comment said "a later step's real resolver…
 *  implements"; this is that implementation. */
export interface ArtifactExistenceCheck {
  readonly hasFn: (fn: number) => boolean;
  readonly hasString: (sid: number) => boolean;
  readonly hasModule: (id: number) => boolean;
}

export class ArtifactEvidenceResolver implements EvidenceResolver {
  private readonly artifact: ArtifactExistenceCheck;
  private readonly dynamic: DynamicResolver;

  constructor(artifact: ArtifactExistenceCheck, dynamic: DynamicResolver = defaultDynamicResolver) {
    this.artifact = artifact;
    this.dynamic = dynamic;
  }

  resolves(ref: string): boolean {
    const kind = refKind(ref);
    const body = ref.slice(ref.indexOf(":") + 1);
    switch (kind) {
      case "fn": {
        const n = Number(body);
        return Number.isInteger(n) && this.artifact.hasFn(n);
      }
      case "reg": {
        // `reg:F:R` — resolves iff the OWNING function F is real; spec 10's
        // artifact index carries no per-register catalogue (only the live,
        // `--hbc`-gated frame query does, spec 10 §3.3), so this is the
        // coarsest honest signal the static index offers without paying for
        // a live bytecode re-parse just to validate an evidence ref.
        const [fnPart, regPart] = body.split(":");
        const fn = Number(fnPart);
        const reg = Number(regPart);
        return Number.isInteger(fn) && Number.isInteger(reg) && reg >= 0 && this.artifact.hasFn(fn);
      }
      case "sid": {
        const n = Number(body);
        return Number.isInteger(n) && this.artifact.hasString(n);
      }
      case "mod": {
        const n = Number(body);
        return Number.isInteger(n) && this.artifact.hasModule(n);
      }
      case "trace":
      case "fuzz":
      case "repro":
        return this.dynamic.resolves(ref);
      case "unknown":
        return false;
    }
  }
}
