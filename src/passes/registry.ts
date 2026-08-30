// docs/specs/00-project-skeleton.md §2.1 — the ordered list of enabled passes. The
// only place a pass is switched on. Empty until M4+ adds the first one.
import type { Pass } from "./types.ts";

export const PASS_REGISTRY: readonly Pass[] = [];
