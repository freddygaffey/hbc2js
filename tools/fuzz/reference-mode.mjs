// tools/fuzz/reference-mode.mjs — shared between construct-fuzz.mjs (live
// campaign driver) and reclassify-finds.mjs (re-triage), so the two never
// drift on how a cell's `mode`/banner is derived.
//
// Split out of construct-fuzz.mjs specifically so this logic is unit-testable
// without importing (and therefore executing) either driver's `main()`.
//
// Background: docs/reports/2026-09-05-campaign2-v96-vm-rediff.md. A traced
// version's cell used to always report `mode: "full-ladder"`, even on a host
// with no Hermes VM for that version (e.g. deb's v96, which had `hermesc`
// but no `hermes` interpreter) — `chooseReference` silently fell back to
// `expected-txt` (Node-captured) and nothing downstream could tell the
// difference. That made a whole campaign's v96 "divergent" numbers actually
// Node-vs-decompiler (D14 says the bytecode/VM is ground truth, not Node),
// not the VM-cross-check the report claimed.

/**
 * A traced version's cell mode. `"full-ladder"` is reserved for when the
 * trace/fuzz oracles actually ran against a real Hermes VM
 * (`reference.engine === "hermes-vm"`); any other engine for a traced
 * version is `"full-ladder-no-vm"` — same oracle set, but the reference was
 * expected.txt/Node, so pass/divergent counts are not a VM-cross-check.
 * Untraced versions (v98) keep the pre-existing `"roundtrip-only"`.
 */
export function modeForCell(isTracedVersion, referenceEngine) {
  if (!isTracedVersion) return "roundtrip-only";
  return referenceEngine === "hermes-vm" ? "full-ladder" : "full-ladder-no-vm";
}

/** One loud, greppable line per version at campaign/reclassify start. */
export function referenceEngineBanner(version, reference) {
  const suffix = reference.engine === "hermes-vm" ? "" : " (no Hermes VM found)";
  return `v${version}: reference engine = ${reference.engine}${suffix} — ${reference.reason}`;
}
